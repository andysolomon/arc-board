import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { Handoff, Plan, Project, RunRecord, Story } from "arc-contracts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(__dirname, "../../packages/arc-contracts/schema");

const ajv = new Ajv({ allErrors: true });

const storySchema = JSON.parse(readFileSync(join(schemaDir, "story.schema.json"), "utf8"));
const handoffSchema = JSON.parse(readFileSync(join(schemaDir, "handoff.schema.json"), "utf8"));
const planSchema = JSON.parse(readFileSync(join(schemaDir, "plan.schema.json"), "utf8"));
const runRecordSchema = JSON.parse(readFileSync(join(schemaDir, "run-record.schema.json"), "utf8"));
const projectSchema = JSON.parse(readFileSync(join(schemaDir, "project.schema.json"), "utf8"));

const validateStoryFn = ajv.compile(storySchema);
const validateHandoffFn = ajv.compile(handoffSchema);
const validatePlanFn = ajv.compile(planSchema);
const validateRunRecordFn = ajv.compile(runRecordSchema);
const validateProjectFn = ajv.compile(projectSchema);

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

export function validatePlan(plan: unknown): plan is Plan {
  if (!validatePlanFn(plan)) {
    throw new Error(`Invalid Plan: ${ajv.errorsText(validatePlanFn.errors)}`);
  }
  return true;
}

export function validateRunRecord(run: unknown): run is RunRecord {
  if (!validateRunRecordFn(run)) {
    throw new Error(`Invalid RunRecord: ${ajv.errorsText(validateRunRecordFn.errors)}`);
  }
  return true;
}

export function validateProject(project: unknown): project is Project {
  if (!validateProjectFn(project)) {
    throw new Error(`Invalid Project: ${ajv.errorsText(validateProjectFn.errors)}`);
  }
  return true;
}
