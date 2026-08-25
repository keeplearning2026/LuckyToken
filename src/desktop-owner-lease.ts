import type {
  ApplicationCommand,
  ApplicationCommandExecution,
} from "@token/application-control-plane/control-plane";

export interface DesktopOwnerLeaseSnapshot {
  readonly leaseId: string;
  readonly expiresAt: number;
}

export interface DesktopOwnerLeaseAuthority {
  claim(leaseId: string): DesktopOwnerLeaseSnapshot;
  renew(leaseId: string): boolean;
  current(): DesktopOwnerLeaseSnapshot | undefined;
  expireIfNeeded(): Promise<boolean>;
}

export interface DesktopOwnerLeaseAuthorityOptions {
  readonly ttlMs: number;
  readonly now: () => number;
  readonly onExpired: () => Promise<void>;
  /** Desktop-owned Backend startup must not live forever if Electron dies
   * before it can claim the first logical shell lease. */
  readonly requireInitialClaim?: boolean;
}

function validateLeaseId(leaseId: string): string {
  if (leaseId.length === 0 || leaseId.trim() !== leaseId || /\s/u.test(leaseId)) {
    throw new Error("Desktop owner lease id must be a non-empty token without whitespace");
  }
  return leaseId;
}

/**
 * Backend-lifetime ownership lease for a desktop-owned Token process.
 * It deliberately tracks a logical desktop shell lease instead of a parent
 * PID: shell handoff may replace one Electron process without restarting the
 * Backend. A new claim supersedes the previous shell; only that lease may
 * renew. Expiry triggers the owner's graceful retirement callback once.
 */
export type DesktopOwnerLeaseCommand = Extract<
  ApplicationCommand,
  { readonly command: "desktop_owner" }
>;

export function executeDesktopOwnerLeaseCommand(
  authority: DesktopOwnerLeaseAuthority | undefined,
  command: DesktopOwnerLeaseCommand,
): ApplicationCommandExecution {
  if (authority === undefined) return { outcome: "unsupported" };
  if (command.action === "claim") {
    authority.claim(command.leaseId);
    return { outcome: "lease_claimed" };
  }
  if (authority.renew(command.leaseId)) {
    return { outcome: "lease_renewed" };
  }
  return {
    outcome: "conflict",
    conflict: {
      code: "desktop_owner_lease_mismatch",
      message: "The desktop ownership lease belongs to a newer Token shell.",
    },
  };
}

export function createDesktopOwnerLeaseAuthority(
  options: DesktopOwnerLeaseAuthorityOptions,
): DesktopOwnerLeaseAuthority {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error("Desktop owner lease TTL must be a positive integer");
  }

  let active: DesktopOwnerLeaseSnapshot | undefined;
  let initialClaimExpiresAt =
    options.requireInitialClaim === true ? options.now() + options.ttlMs : undefined;
  let retired = false;

  const snapshot = (leaseId: string): DesktopOwnerLeaseSnapshot =>
    Object.freeze({
      leaseId: validateLeaseId(leaseId),
      expiresAt: options.now() + options.ttlMs,
    });

  return Object.freeze({
    claim(leaseId: string): DesktopOwnerLeaseSnapshot {
      if (retired) throw new Error("Desktop owner lease has expired");
      initialClaimExpiresAt = undefined;
      active = snapshot(leaseId);
      return active;
    },
    renew(leaseId: string): boolean {
      if (retired || active?.leaseId !== leaseId) return false;
      active = snapshot(leaseId);
      return true;
    },
    current: () => active,
    async expireIfNeeded(): Promise<boolean> {
      if (retired) return false;
      const current = active;
      const expiresAt = current?.expiresAt ?? initialClaimExpiresAt;
      if (expiresAt === undefined || options.now() < expiresAt) {
        return false;
      }
      // Clear first so concurrent/subsequent checks cannot fire retirement
      // twice while the graceful drain is still in progress.
      retired = true;
      active = undefined;
      initialClaimExpiresAt = undefined;
      await options.onExpired();
      return true;
    },
  });
}
