import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { runCodexImageGeneration } from "./client.ts";
import { resolveInputImagePaths, saveGeneratedImage, validateOutputRequest } from "./output.ts";

interface ImageGenerationDetails {
	path?: string;
	mimeType?: string;
	byteLength?: number;
	inputImageCount: number;
	revisedPrompt?: string;
	status?: string;
	// Renderer-only payload, never included in model-visible content.
	previewData?: string;
}

const imageGenerationTool = defineTool({
	name: "image_generation",
	label: "Image Generation",
	description: "Generate a new image or edit up to four local source images through the installed Codex CLI's native image-generation capability. Requires `codex` 0.146.0 or newer and a ChatGPT Codex login. Saves one image inside the current working directory and returns text metadata, not image content. Explicitly read the saved file when visual inspection is needed. The prompt and any input images are sent to OpenAI.",
	promptSnippet: "Generate or edit an image through Codex native image generation and save it locally",
	promptGuidelines: [
		"Use image_generation when the user asks to create, generate, or edit an image file.",
		"Before image_generation sends a prompt or local input images to OpenAI, require an explicit user request for that specific generation or edit; do not infer permission from unrelated work.",
		"Pass only the minimum necessary prompt and input images to image_generation; never include secrets, credentials, unrelated files, or unrelated conversation context.",
		"Use image_generation.inputImages for source-image edits and image_generation.outputPath for the requested local result.",
		"image_generation returns text metadata, not model-visible image content. Use read on the saved path only when visual inspection is needed; the interactive preview does not mean you have inspected the image.",
	],
	parameters: Type.Object({
		prompt: Type.String({
			minLength: 1,
			maxLength: 10_000,
			description: "A self-contained instruction for the image to create or the edits to make. This text is sent to OpenAI.",
		}),
		outputPath: Type.String({
			minLength: 1,
			description: "Destination path inside the current working directory. Use .png, .jpg/.jpeg, .webp, or .gif; the extension must match Codex's returned format.",
		}),
		inputImages: Type.Optional(Type.Array(
			Type.String({
				minLength: 1,
				description: "A local source-image path, relative to the current working directory or absolute. The image is sent to OpenAI.",
			}),
			{
				maxItems: 4,
				description: "Optional source images for editing or visual reference.",
			},
		)),
		overwrite: Type.Optional(Type.Boolean({
			description: "Replace an existing regular output file. Defaults to false. Symbolic links are never replaced.",
		})),
	}, { additionalProperties: false }),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const overwrite = params.overwrite ?? false;
		await validateOutputRequest(ctx.cwd, params.outputPath, overwrite, signal);
		const inputImages = await resolveInputImagePaths(ctx.cwd, params.inputImages ?? []);
		const result = await runCodexImageGeneration(params.prompt, inputImages, {
			signal,
			onProgress(message) {
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { inputImageCount: inputImages.length } satisfies ImageGenerationDetails,
				});
			},
		});
		const saved = await saveGeneratedImage(ctx.cwd, params.outputPath, result, overwrite, signal);
		const details: ImageGenerationDetails = {
			path: saved.displayPath,
			mimeType: result.mimeType,
			byteLength: result.byteLength,
			inputImageCount: inputImages.length,
			revisedPrompt: result.revisedPrompt,
			status: result.status,
			...(ctx.mode === "tui" ? { previewData: result.data } : {}),
		};
		return {
			content: [
				{
					type: "text",
					text: `${inputImages.length > 0 ? "Edited" : "Generated"} image: ${saved.displayPath}\nMIME: ${result.mimeType}\nBytes: ${result.byteLength}\nStatus: ${result.status}`,
				},
			],
			details,
		};
	},

	renderResult(result, { isPartial }, theme, context) {
		const container = new Container();
		const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		container.addChild(new Text(text, 0, 0));
		const details = result.details as ImageGenerationDetails | undefined;
		if (!isPartial && !context.isError && context.showImages && details?.previewData && details.mimeType) {
			container.addChild(new Image(details.previewData, details.mimeType, {
				fallbackColor: (value) => theme.fg("muted", value),
			}, { maxWidthCells: 80, maxHeightCells: 24 }));
		}
		return container;
	},
});

export default function (pi: ExtensionAPI): void {
	pi.registerTool(imageGenerationTool);
}
