/**
 * pi-smart-paste — Smart clipboard paste for pi on Windows.
 *
 * The built-in `app.clipboard.pasteImage` action only handles images. When you
 * copy a *file* in Explorer, the clipboard carries a file-drop list (not text,
 * not an image), so a plain paste does nothing. This extension makes paste
 * content-aware, checked in priority order:
 *
 *   1. Copied FILES -> paste their absolute paths (one per line)
 *   2. Copied IMAGE -> save to a temp png and paste the path (built-in parity)
 *   3. Copied TEXT  -> paste the text silently (do NOT hijack normal pasting!)
 *   4. Empty        -> notify the user
 *
 * Commands:  /paste (smart)  /paste-file (files only)  /paste-image (image only)
 * Shortcuts: ctrl+v / ctrl+shift+v / alt+v (smart)   ctrl+shift+i (image only)
 *
 * For ctrl+v / alt+v to reach this extension, keybindings.json should clear
 * the built-in image-paste action:
 *   { "app.clipboard.pasteImage": [] }
 *
 * Platform: Windows only (PowerShell STA + System.Windows.Forms).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type UICtx = {
	ui: {
		pasteToEditor: (t: string) => void;
			notify: (msg: string, level?: "info" | "warning" | "error") => void;
	};
};

type Probe =
	| { kind: "files"; files: string[] }
	| { kind: "image"; imagePath: string }
	| { kind: "text"; text: string }
	| { kind: "empty" };

/** Run a PowerShell snippet in STA mode (required for Clipboard APIs). */
function runPowerShellSta(script: string, timeoutMs = 8000): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-STA", "-Command", script],
			{ windowsHide: true },
		);
		let stdout = "";
		let settled = false;
		const finish = (s: string) => {
			if (settled) return;
			settled = true;
			resolve(s);
		};
		child.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		// swallow stderr; failures surface as an empty/EMPTY result
		child.stderr?.on("data", () => {});
		child.on("close", (code) => finish(code === 0 ? stdout : ""));
		child.on("error", () => finish(""));
		setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
			finish("");
		}, timeoutMs);
	});
}

/**
 * Probe the clipboard once: file-drop list first, then image, then text.
 * Text is returned base64-encoded on its own line so newlines can't corrupt the
 * tag framing. Output encoding is forced to UTF-8 so non-ASCII paths survive.
 */
async function probeClipboard(): Promise<Probe> {
	const imagePath = join(tmpdir(), `pi-clip-${randomUUID()}.png`);
	const psImg = imagePath.replaceAll("'", "''");
	const script = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"$files = [System.Windows.Forms.Clipboard]::GetFileDropList()",
		"if ($files.Count -gt 0) {",
		"  Write-Output 'FILES'",
		"  foreach ($f in $files) { Write-Output $f }",
		"} else {",
		"  $img = [System.Windows.Forms.Clipboard]::GetImage()",
		"  if ($img) {",
		`    $img.Save('${psImg}', [System.Drawing.Imaging.ImageFormat]::Png)`,
		"    Write-Output 'IMAGE'",
		`    Write-Output '${psImg}'`,
		"  } else {",
		"    $txt = [System.Windows.Forms.Clipboard]::GetText()",
		"    if ($txt) {",
		"      $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($txt))",
		"      Write-Output 'TEXT'",
		"      Write-Output $b64",
		"    } else {",
		"      Write-Output 'EMPTY'",
		"    }",
		"  }",
		"}",
	].join("\n");

	const out = await runPowerShellSta(script);
	const lines = out
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const tag = lines[0];

	if (tag === "FILES") {
		const files = lines.slice(1).filter(Boolean);
		return files.length ? { kind: "files", files } : { kind: "empty" };
	}
	if (tag === "IMAGE") {
		try {
			if (readFileSync(imagePath).length > 0) {
				return { kind: "image", imagePath };
			}
		} catch {
			/* fall through */
		}
	}
	if (tag === "TEXT") {
		try {
			const text = Buffer.from(lines[1] ?? "", "base64").toString("utf8");
			if (text) return { kind: "text", text };
		} catch {
			/* fall through */
		}
	}
	return { kind: "empty" };
}

function notifyEmpty(ctx: UICtx) {
	ctx.ui.notify("Clipboard is empty. Copy a file, screenshot, or text first.", "warning");
}

async function smartPaste(ctx: UICtx) {
	const probe = await probeClipboard();
	if (probe.kind === "files") {
		ctx.ui.pasteToEditor(probe.files.join("\n"));
		ctx.ui.notify(`Pasted ${probe.files.length} file path(s)`, "info");
		return;
	}
	if (probe.kind === "image") {
		ctx.ui.pasteToEditor(probe.imagePath);
		ctx.ui.notify(`Pasted image: ${probe.imagePath}`, "info");
		return;
	}
	if (probe.kind === "text") {
		// Plain text: paste silently. Normal pasting must NOT show a notification.
		ctx.ui.pasteToEditor(probe.text);
		return;
	}
	notifyEmpty(ctx);
}

async function pasteFiles(ctx: UICtx) {
	const probe = await probeClipboard();
	if (probe.kind !== "files") {
		ctx.ui.notify("Clipboard has no files. Copy a file first, then use /paste-file.", "warning");
		return;
	}
	ctx.ui.pasteToEditor(probe.files.join("\n"));
	ctx.ui.notify(`Pasted ${probe.files.length} file path(s)`, "info");
}

async function pasteImage(ctx: UICtx) {
	const probe = await probeClipboard();
	if (probe.kind === "files") {
		// files present but user asked for image -> still give them something useful
		ctx.ui.pasteToEditor(probe.files.join("\n"));
		ctx.ui.notify(`Clipboard has files; pasted ${probe.files.length} path(s)`, "info");
		return;
	}
	if (probe.kind !== "image") {
		ctx.ui.notify("Clipboard has no image. Copy an image first, then use /paste-image.", "warning");
		return;
	}
	ctx.ui.pasteToEditor(probe.imagePath);
	ctx.ui.notify(`Pasted image: ${probe.imagePath}`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("paste", {
		description: "Smart paste: file paths if files copied, else image, else text",
		handler: async (_args, ctx) => {
			await smartPaste(ctx);
		},
	});
	pi.registerCommand("paste-file", {
		description: "Paste copied file paths (files only)",
		handler: async (_args, ctx) => {
			await pasteFiles(ctx);
		},
	});
	pi.registerCommand("paste-image", {
		description: "Paste clipboard image into the editor (Windows fallback)",
		handler: async (_args, ctx) => {
			await pasteImage(ctx);
		},
	});

	// Smart paste (content-aware). Ctrl+V is the primary chord — it was already
	// bound to the built-in pasteImage in the user's keybindings, so pi receives
	// it as a keypress here. Intercept it to paste file paths when files are
	// copied, falling back to image, then plain text (silent).
	pi.registerShortcut("ctrl+v", {
		description: "Smart paste (file paths / image / text) — takes over Ctrl+V",
		handler: async (ctx) => {
			await smartPaste(ctx);
		},
	});
	pi.registerShortcut("ctrl+shift+v", {
		description: "Smart paste (file paths / image / text), alternate",
		handler: async (ctx) => {
			await smartPaste(ctx);
		},
	});
	// Alt+V: take over from built-in image paste for smart paste.
	pi.registerShortcut("alt+v", {
		description: "Smart paste (file paths / image / text) — takes over Alt+V",
		handler: async (ctx) => {
			await smartPaste(ctx);
		},
	});
	// Legacy image-only chord kept for muscle memory.
	pi.registerShortcut("ctrl+shift+i", {
		description: "Paste clipboard image",
		handler: async (ctx) => {
			await pasteImage(ctx);
		},
	});
}
