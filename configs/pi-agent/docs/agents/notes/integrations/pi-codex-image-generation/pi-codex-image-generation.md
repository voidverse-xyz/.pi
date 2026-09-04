# Pi Codex image generation

## Objective

Expose Codex native image generation as one Pi tool without adding an API key, parsing or persistently copying authentication tokens, or handing the entire Pi conversation and repository to a nested general-purpose Codex agent.

## Verified contracts

The installed Codex CLI reports `image_generation` as a stable enabled feature. Its generated app-server v2 protocol defines:

- `modelProvider/capabilities/read`, returning the `imageGeneration` capability flag;
- `turn/start` user input containing text plus optional local-path or URL-backed image entries;
- completed `imageGeneration` items containing `status`, base64 `result`, optional `revisedPrompt`, and optional `savedPath`;
- ordinary `item/started`, `item/completed`, and `turn/completed` lifecycle notifications.

Pi extensions can register an LLM-callable tool with `pi.registerTool()`/`defineTool()`, return combined text and `ImageContent`, stream partial progress through `onUpdate`, honor the supplied abort signal, and serialize file mutations with `withFileMutationQueue()`.

## Design

`pi-codex-image-generation` registers `image_generation` with four fields:

1. `prompt`: required image instruction, at most 10,000 characters;
2. `outputPath`: required project-confined output path;
3. `inputImages`: zero to four local source images;
4. `overwrite`: explicit replacement opt-in, defaulting to false.

The package invokes the installed Codex app-server directly. It does not use `codex exec` as a broad agent handoff: the app-server protocol provides exact capability checks, item allowlisting, thread/turn identity checks, cancellation, progress, and base64 result handling without parsing prose or granting a shell.

## Data flow and isolation

For every tool call:

1. Resolve the explicitly listed input paths, reject symbolic links, compare the opened inode to the checked path, and bounded-read each image through a no-follow file handle while validating count, type, and size.
2. Embed source images as data URLs in the app-server input. The native image tool can consume these attachments without receiving or resolving a local filesystem path.
3. Create a fresh temporary working directory, isolated HOME/XDG/application-data roots, and a clean temporary Codex home that bridges only the existing login, using a filesystem link where supported and a permission-restricted ephemeral copy otherwise. User Codex configuration is not copied or loaded, and token values are never parsed or logged.
4. Start `codex app-server --stdio` with explicit MCP/plugin removal as defense in depth.
5. Require Codex 0.146.0+, ChatGPT-backed login, and provider image support.
6. Verify effective configuration has no enabled MCP, hook, plugin, app, connector, skill, or instruction surface.
7. Start one ephemeral thread with empty environments/capability roots/dynamic tools, read-only sandboxing, explicit image-only instructions, and all non-image features disabled.
8. Reject inherited instruction sources, server requests, unknown items, mismatched thread/turn ids, multiple generated images, malformed base64, unsupported formats, and oversized results.
9. Preflight the destination before network use, then atomically write the result through Pi's file-mutation queue and a descriptor-anchored parent directory. Linux uses `/proc/self/fd`; Windows uses a bundled Python helper under WSL for handle-relative traversal, staging, and commit. Abort is checked through the final commit.
10. Close the subprocess and remove temporary files, including the bridged login, on every exit path.

Only the explicit prompt, static image-worker instructions, and embedded bytes of listed input images are placed in model input. Pi messages, system instructions, repository contents, credential values, original paths, and the requested output path are not placed in model input or logs; the bridged Codex login still authenticates the transport.

## File safety

Output parents must already exist. Paths are lexically and realpath-confined to Pi's current working directory, then the parent inode is opened and held for descriptor-relative target checks and commits. Linux uses `/proc/self/fd`; Windows requires WSL with Python 3 and rejects absolute paths, alternate data streams, reserved device names, trailing dots/spaces, and ambiguous path components before invoking its helper. Supported suffixes are `.png`, `.jpg`/`.jpeg`, `.webp`, and `.gif`; the suffix must match the generated file signature. Existing files require `overwrite: true`, symbolic links are always refused, and writes use an exclusive same-directory temporary file followed by rename or a no-clobber hard link.

## Verification scope

Automated tests cover registration, schemas, generate/edit requests, capability and authentication failures, inherited configuration/instruction refusal, item allowlisting, thread/turn mismatches, malformed image data, input limits and formats, cancellation/timeout cleanup, clean-home authentication bridging, output confinement, symlink refusal, overwrite behavior, atomic writes, and inline image results.

Verification completed with Codex 0.146.0:

- all 15 local fake-server and filesystem tests pass, including output preflight, an adversarial ancestor swap, cancellation after the temporary write, stubborn descendant termination, cleanup across success/failure/cancellation/timeout, oversized and symbolic-link inputs, duplicate images, and server requests;
- an actual app-server preflight reports ChatGPT authentication, image-generation capability, empty effective MCP/plugin configuration, and no inherited thread instruction sources;
- an authorized generation-only live smoke test produced a valid 1,254 × 1,254 PNG, saved it through the tool, and returned an inline preview without uploading a local source image;
- a live source-edit test exposed that app-server `localImage` paths were unavailable to the native image tool. Embedding the validated image bytes instead fixed the integration, and the retried edit produced a valid 1,254 × 1,254 PNG with the requested bottom row.
