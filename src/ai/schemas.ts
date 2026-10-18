// JSON schemas of the AI replies (structured output). Every object lists all its properties as
// required and forbids extra ones; "no value" is an empty string or empty array.
import { type JsonSchema } from "./provider";

const str = { type: "string" };
const strArray = { type: "array", items: { type: "string" } };

function object(properties: Record<string, unknown>): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const newTask = object({
  ref: { type: "string", description: "Short reference for this new task, e.g. N1, N2 …" },
  title: str,
  estimate: { type: "string", description: "Duration such as 4h, 1.5d or 1w; empty when unknown" },
  tags: { ...strArray, description: "Tags without #, lower case" },
  owner: { type: "string", description: "Person id from the team, or empty" },
  dependsOn: { ...strArray, description: "Refs of other new tasks or ids of existing tasks (T…)" },
  notes: { type: "string", description: "One or two sentences, or empty" },
});

export const BREAKDOWN_SCHEMA = object({
  subtasks: { type: "array", items: newTask },
  rationale: str,
});

export const ESTIMATE_SCHEMA = object({
  estimates: {
    type: "array",
    items: object({
      id: str,
      estimate: { type: "string", description: "e.g. 6h, 2d, 1w" },
      rationale: { type: "string", description: "One line" },
    }),
  },
});

export const CALIBRATE_SCHEMA = object({
  insights: {
    ...strArray,
    description: "2–6 short lines, e.g. '#frontend tasks: you underestimate by 28% (n = 14)'",
  },
  skip: { type: "array", items: object({ id: str, reason: str }) },
});

export const OWNERS_SCHEMA = object({
  assignments: {
    type: "array",
    items: object({
      id: str,
      owner: str,
      reason: { type: "string", description: "Why this person: skills, load, time off" },
    }),
  },
});

export const PLAN_FROM_TEXT_SCHEMA = object({
  section: { type: "string", description: "Title of the new section (work package)" },
  tasks: {
    type: "array",
    items: {
      ...newTask,
      properties: {
        ...(newTask.properties as object),
        parent: {
          type: "string",
          description: "Ref of the parent new task for a subtask, or empty",
        },
      },
      required: [...(newTask.required as string[]), "parent"],
    },
  },
});

export const SUMMARY_SCHEMA = object({ summary: { type: "string", description: "5–8 sentences" } });

export const REVIEW_SCHEMA = object({
  risks: {
    type: "array",
    items: object({
      severity: { type: "string", enum: ["high", "medium", "low"] },
      title: str,
      detail: str,
      tasks: { ...strArray, description: "Task or milestone ids involved" },
    }),
  },
});
