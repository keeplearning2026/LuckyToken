// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CredentialCommand,
  CredentialCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { CredentialsPage } from "../src/credentials-page.js";
import type { WindowsShellHost } from "../src/shell-lifecycle.js";

/**
 * Ticket 12 UI adapter seam: the Credentials page renders the bounded
 * status facts, stores API-key credentials through the single authority
 * seam, removes only the stored value on logout, and drives the
 * Provider-by-Provider import confirmation. Renderer state never carries
 * credential values.
 */
function shellWithCommands(
  handler: (
    command: CredentialCommand,
  ) => CredentialCommandResult | Promise<CredentialCommandResult>,
): WindowsShellHost {
  return {
    executeCredentialCommand: (command: CredentialCommand) =>
      Promise.resolve(handler(command)),
  } as unknown as WindowsShellHost;
}

const projection = {
  revision: 2,
  path: "C:\\Users\\me\\.luckytoken\\auth.json",
  present: true,
  valid: true,
  providers: [
    {
      providerId: "anthropic",
      stored: true,
      storedType: "api_key",
      environment: false,
      modelsJson: false,
      commandDerived: false,
      expired: false,
      unavailable: false,
      effectiveSource: "stored",
    },
    {
      providerId: "my-gateway",
      stored: false,
      environment: false,
      modelsJson: true,
      commandDerived: false,
      expired: false,
      unavailable: false,
      effectiveSource: "models.json",
    },
  ],
};

describe("Credentials page renderer seam", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  function render(shell: WindowsShellHost) {
    act(() => {
      root.render(
        <CredentialsPage credentials={projection as never} shell={shell} />,
      );
    });
  }

  it("queries the authority on page open so external auth.json edits refresh", () => {
    const commands: CredentialCommand[] = [];
    render(
      shellWithCommands(async (command) => {
        commands.push(command);
        return {
          outcome: "ok",
          revision: 2,
          state: projection as never,
        };
      }),
    );
    // The mount query runs exactly once per page open; no polling.
    expect(commands).toEqual([{ command: "query" }]);
  });

  it("renders the bounded status facts and never credential values", () => {
    render(
      shellWithCommands(async () => ({
        outcome: "ok",
        revision: 2,
        state: projection as never,
      })),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("anthropic");
    expect(text).toContain("stored: API key");
    expect(text).toContain("my-gateway");
    expect(text).toContain("models.json API key");
    expect(text).toContain("auth.json");
    expect(text).not.toContain("sk-");
  });

  it("stores a literal API key through the authority seam", async () => {
    const commands: CredentialCommand[] = [];
    render(
      shellWithCommands(async (command) => {
        commands.push(command);
        return {
          outcome: "ok",
          revision: 3,
          changed: true,
          state: {
            ...(projection as object),
            revision: 3,
          } as never,
        };
      }),
    );
    const inputs = container.querySelectorAll("input[type='password']");
    await act(async () => {
      const input = inputs[0] as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "sk-ui-login-canary-1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Store API key credential",
      );
      button?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    const login = commands.find((entry) => entry.command === "login");
    expect(login).toMatchObject({
      command: "login",
      providerId: "anthropic",
      expectedRevision: 2,
      value: "sk-ui-login-canary-1",
      overwrite: false,
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Stored API key credential for anthropic.");
    expect(text).not.toContain("sk-ui-login-canary-1");
  });

  it("logout removes the stored value through the authority seam", async () => {
    const commands: CredentialCommand[] = [];
    render(
      shellWithCommands(async (command) => {
        commands.push(command);
        return {
          outcome: "ok",
          revision: 3,
          changed: true,
          state: projection as never,
        };
      }),
    );
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Logout",
      );
      button?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    const logout = commands.find((entry) => entry.command === "logout");
    expect(logout).toMatchObject({
      command: "logout",
      providerId: "anthropic",
      expectedRevision: 2,
    });
    expect(container.textContent).toContain(
      "Stored credential removed for anthropic.",
    );
  });

  it("shows the invalid-file error and refuses commands that fail explicitly", async () => {
    render(
      shellWithCommands(async () => ({
        outcome: "conflict",
        revision: 3,
        state: projection as never,
        error: "Credential state changed; re-query and retry",
      })),
    );
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Logout",
      );
      button?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain(
      "Credential state changed; re-query and retry",
    );
  });
});
