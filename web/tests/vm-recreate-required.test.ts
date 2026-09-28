import { describe, expect, test } from "bun:test";
import type { Freestyle } from "freestyle";

import { locales } from "../i18n/routing";
import { FreestyleProvider } from "../services/vms/drivers/freestyle";
import { VmProviderOperationError } from "../services/vms/errors";
import { isOperatorFaultVmError } from "../services/vms/observability";
import { vmWorkflowErrorResponse } from "../services/vms/routeHelpers";

const VM_ID = "vm-4f7fb2ef6cb049d090dc65e2fa310d0f";

// Production 2026-09 (PostHog `cmux-vm-error:vm_cloud_service_unavailable`,
// 62k events in 3 days from one team): a Freestyle row that predates the
// snapshot-v2 machine contract answered attach with 502
// vm_cloud_service_unavailable, retryable: true, operator_fault: true. The row
// can never become attachable, so the Mac retried it forever. The answer must
// be a permanent, typed, non-retryable state that tells the user to recreate
// the machine.
async function legacyAttachFailure(providerMetadata: Record<string, unknown>): Promise<unknown> {
  const client = { vms: { ref: () => ({}) } } as unknown as Freestyle;
  const provider = new FreestyleProvider({ client: () => client });
  try {
    await provider.openCmuxRemote(VM_ID, { providerMetadata });
  } catch (cause) {
    // The same wrapping the provider gateway applies (providerEffect).
    return new VmProviderOperationError({ provider: "freestyle", operation: "openCmuxRemote", cause });
  }
  throw new Error("a legacy row must not produce an attach endpoint");
}

describe("legacy Cloud machines answer vm_recreate_required", () => {
  for (const [name, providerMetadata] of [
    ["without the snapshot-v2 contract", { networkIpv4: "10.4.0.8" }],
    ["without recorded addresses", { cmuxTuiContract: "snapshot-v2" }],
    ["with no metadata", {}],
  ] as const) {
    test(`a row ${name} is a permanent 409, not a retryable outage`, async () => {
      const response = await vmWorkflowErrorResponse(await legacyAttachFailure(providerMetadata));
      expect(response).not.toBeNull();
      expect(response!.status).toBe(409);
      expect(response!.headers.get("retry-after")).toBeNull();
      const payload = await response!.json() as Record<string, unknown>;
      expect(payload).toMatchObject({
        error: "vm_recreate_required",
        retryable: false,
        phase: "attach",
        details: { operation: "openCmuxRemote", retryable: false, recreateRequired: true },
        ui: { retryable: false, severity: "error" },
      });
      expect(String(payload.message)).toMatch(/recreate|new machine/i);
      expect(String(payload.action)).toMatch(/Delete/);
      // No provider or contract internals reach the caller.
      expect(JSON.stringify(payload)).not.toMatch(/freestyle|snapshot-v2|temporarily unavailable/i);
    });
  }

  test("the recreate answer is localized from the request locale", async () => {
    const response = await vmWorkflowErrorResponse(await legacyAttachFailure({}), { locale: "ja" });
    const payload = await response!.json() as Record<string, unknown>;
    expect(payload.error).toBe("vm_recreate_required");
    expect(String(payload.message)).toMatch(/[぀-ヿ]/);
  });

  test("every locale has the recreate copy", async () => {
    const failure = await legacyAttachFailure({});
    for (const locale of locales) {
      const response = await vmWorkflowErrorResponse(failure, { locale });
      const payload = await response!.json() as { error: string; message: string; action: string; ui: { title: string } };
      expect(payload.error).toBe("vm_recreate_required");
      expect(payload.ui.title.length).toBeGreaterThan(0);
      expect(payload.message.length).toBeGreaterThan(0);
      expect(payload.action.length).toBeGreaterThan(0);
      expect(JSON.stringify(payload)).not.toContain("vmErrors.recreateRequired");
    }
  });

  test("vm_recreate_required is the user's machine state, not an operator fault", () => {
    expect(isOperatorFaultVmError({ error: "vm_recreate_required", status: 409 })).toBe(false);
    // A permanent client-state code stays out of the operator-fault signal at any status.
    expect(isOperatorFaultVmError({ error: "vm_recreate_required", status: 502 })).toBe(false);
  });

  test("an unrelated provider failure during attach stays a retryable outage", async () => {
    const response = await vmWorkflowErrorResponse(new VmProviderOperationError({
      provider: "freestyle",
      operation: "openCmuxRemote",
      cause: new Error("socket hang up"),
    }));
    expect(response!.status).toBe(502);
    const payload = await response!.json() as { error: string; retryable: boolean };
    expect(payload.error).toBe("vm_cloud_service_unavailable");
    expect(payload.retryable).toBe(true);
  });
});
