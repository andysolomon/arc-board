import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { Handoff, Story } from "arc-contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(__dirname, "../../packages/arc-contracts/schema");

const ajv = new Ajv({ allErrors: true });

const storySchema = JSON.parse(readFileSync(join(schemaDir, "story.schema.json"), "utf8"));
const handoffSchema = JSON.parse(readFileSync(join(schemaDir, "handoff.schema.json"), "utf8"));

const validateStoryFn = ajv.compile(storySchema);
const validateHandoffFn = ajv.compile(handoffSchema);

export function validateStory(story: unknown): story is Story {
  if (!validateStoryFn(story)) {
    throw new Error(`Invalid Story: ${ajv.errorsText(validateStoryFn.errors)}`);
  }
  return true;
}

export function validateHandoff(handoff: unknown): handoff is Handoff {
  if (!validateHandoffFn(handoff)) {
    throw new Error(`Invalid Handoff: ${ajv.errorsText(validateHandoffFn.errors)}`);
  }
  return true;
}
