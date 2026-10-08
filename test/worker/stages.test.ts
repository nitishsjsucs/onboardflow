import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { STAGES, TASK_TEMPLATES } from "../../src/shared/stages.ts";
import { auditActions, driveHappyPath, fastWorkflows } from "../helpers/workflow.ts";

describe("eight stages", () => {
  it("STAGES has 8 entries with ordinals 1..8, equal to the D1 stages table", async () => {
    expect(STAGES).toHaveLength(8);
    expect(STAGES.map((s) => s.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const rows = await env.DB.prepare("SELECT id, ordinal, name, owner, gate FROM stages ORDER BY ordinal").all();
    expect(rows.results).toEqual(STAGES.map((s) => ({ id: s.id, ordinal: s.ordinal, name: s.name, owner: s.owner, gate: s.gate })));
  });

  it("the D1 task templates equal TASK_TEMPLATES", async () => {
    const rows = await env.DB.prepare("SELECT key, stage_id, assignee, title, description, due_offset_days, sort FROM task_templates ORDER BY sort").all();
    expect(rows.results).toEqual(
      TASK_TEMPLATES.map((t) => ({ key: t.key, stage_id: t.stageId, assignee: t.assignee, title: t.title, description: t.description, due_offset_days: t.dueOffsetDays, sort: t.sort })),
    );
  });

  it("a full run starts and completes all 8 stages in ordinal order", async () => {
    const intro = await fastWorkflows();
    try {
      expect((await driveHappyPath("E061")).status).toBe("complete");
    } finally {
      await intro.dispose();
    }
    const trail = (await auditActions("E061")).filter((a) => a.action === "stage.started" || a.action === "stage.completed");
    const expected = STAGES.flatMap((s) => [`stage.started:${s.id}`, `stage.completed:${s.id}`]);
    expect(trail.map((a) => `${a.action}:${a.stage_id}`)).toEqual(expected);
  });
});
