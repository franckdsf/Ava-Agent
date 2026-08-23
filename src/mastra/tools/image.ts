import { createTool } from "@mastra/core/tools"
import Replicate from "replicate"
import { z } from "zod"
import { env } from "../../config/env";

const replicate = new Replicate({
  auth: env.REPLICATE_API_KEY
});


const parseReplicateRunOutput = async (output: object) => {
  // Output is an array of FileOutput objects
  const outputs = Array.isArray(output) ? output : [output];

  return await Promise.all(outputs.map(async (fileOutput: {
    url: () => Promise<{ href: string }>,
    blob: () => Promise<Blob>
  }) => {
    return {
      toBuffer: async () => {
        const blob = await fileOutput.blob();
        return Buffer.from(await blob.arrayBuffer());
      },
      toUrl: async () => {
        const url = await fileOutput.url();
        return (url.href ?? url) as string;
      }
    }
  }));
}

const MAX_PIXELS = 1024 * 768;
const aspectRatios = {
  '1:1': 1 / 1,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
};

const aspectRatioToDimensions = Object.fromEntries(
  Object.entries(aspectRatios).map(([key, ratio]) => {
    const width = Math.round(Math.sqrt(MAX_PIXELS * ratio));
    const height = Math.round(width / ratio);

    return [key, { width, height }];
  })
);

const generateImage = createTool({
  id: 'generate-image',
  description: 'Generate an image based on a text prompt. The prompt must be detailed.',
  inputSchema: z.object({
    prompt: z.string().min(1).max(3000).describe('A short prompt describing the image to generate.'),
    aspectRatio: z.enum(['3:4', '4:3', '16:9']).default('4:3'),
  }),
  outputSchema: z.object({
    url: z.string().url().describe('The URL of the generated image.'),
    dimensions: z.object({
      width: z.number().int().describe('The width of the generated image in pixels.'),
      height: z.number().int().describe('The height of the generated image in pixels.'),
    }).describe('The dimensions of the generated image.')
  }),
  execute: async ({ prompt, aspectRatio }) => {
    const dimensions = aspectRatioToDimensions[aspectRatio] ?? aspectRatioToDimensions['4:3']!;

    const input = {
      go_fast: false,
      guidance_scale: 0,
      num_inference_steps: 8,
      output_format: "webp",
      output_quality: 100,
      prompt,
      width: dimensions.width,
      height: dimensions.height,
    }

    const result = await replicate.run("prunaai/z-image-turbo", { input });
    const output = await parseReplicateRunOutput(result);

    const urls = await Promise.all(output.map((o) => o.toUrl()));
    const url = urls[0]!;

    return {
      url,
      dimensions,
    }
  }
})

/**
 * Newy's image tool — present only when `REPLICATE_API_KEY` is set.
 *
 * An empty object rather than a tool that throws on first call: the key is the
 * one optional credential in this repo
 * ([ADR-0041](../../../docs/decisions/0041-one-deployment-one-reader.md)), and a
 * deployment without it should have a Newy that never offers to draw, not one
 * that offers and then fails.
 */
export const imageTools: Partial<Record<'generateImage', typeof generateImage>> =
  env.REPLICATE_API_KEY ? { generateImage } : {}