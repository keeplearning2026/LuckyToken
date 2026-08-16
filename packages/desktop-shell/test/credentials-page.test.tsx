// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthCommand,
  AuthCommandResult,
  AuthInteractionEvent,
  AuthInteractionResponse,
  AuthProviderOption,
  CredentialCommand,
  CredentialCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { CredentialsPage } from "../src/credentials-page.js";
import type { WindowsShellHost } from "../src/shell-lifecycle.js";

/**
 * Ticket 12 + Ticket 13 UI adapter seam: the Credentials page renders the
 * bounded status facts, offers the two exact top-level choices ("Use an
 * account or subscription" / "Use an API key") per Provider from metadata
 * only, projects typed Provider-owned AuthInteraction events (browser
 * URL, device code, select, text, secret, progress, info, cancel,
 * success, failure) with OS URL opening and visible/copyable fallback,
 * stores API-key credentials through the single authority seam, removes
 * only the stored value on logout, and drives the Provider-by-Provider
 * import confirmation. Renderer state never carries credential values and
 * contains no Provider ID branches.
 */

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

/** Provider-declared login options (metadata only; `subscription` is the
 *  Provider's own oauth.isSubscription fact). */
const anthropicOption: AuthProviderOption = {
  providerId: "anthropic",
  name: "Anthropic",
  account: true,
  subscription: true,
  apiKey: true,
  status: {
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
};

const gatewayOption: AuthProviderOption = {
  providerId: "my-gateway",
  name: "My Gateway",
  account: false,
  subscription: false,
  apiKey: true,
  status: {
    providerId: "my-gateway",
    stored: false,
    environment: false,
    modelsJson: true,
    commandDerived: false,
    expired: false,
    unavailable: false,
    effectiveSource: "models.json",
  },
};

const authQueryResult: AuthCommandResult = {
  outcome: "ok",
  state: projection as never,
  options: { providers: [anthropicOption, gatewayOption] },
};

function makeShell(overrides: {
  credential?: (
    command: CredentialCommand,
  ) => CredentialCommandResult | Promise<CredentialCommandResult>;
  authQuery?: AuthCommandResult;
  onLogin?: (
    command: Extract<AuthCommand, { readonly command: "login" }>,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ) => Promise<AuthCommandResult>;
  onRespond?: (response: AuthInteractionResponse) => Promise<void>;
  onOpenUrl?: (url: string) => Promise<void>;
} = {}): WindowsShellHost {
  return {
    executeCredentialCommand: (command: CredentialCommand) =>
      Promise.resolve(
        overrides.credential?.(command) ?? {
          outcome: "ok",
          revision: 2,
          state: projection as never,
        },
      ),
    executeAuthCommand: (
      command: AuthCommand,
      onInteraction?: (event: AuthInteractionEvent) => void,
    ) => {
      if (command.command === "query") {
        return Promise.resolve(overrides.authQuery ?? authQueryResult);
      }
      return (
        overrides.onLogin?.(command, onInteraction) ??
        Promise.reject(new Error("no login script"))
      );
    },
    respondAuthInteraction: (response: AuthInteractionResponse) =>
      overrides.onRespond?.(response) ?? Promise.resolve(),
    openUrl: (url: string) => overrides.onOpenUrl?.(url) ?? Promise.resolve(),
  } as unknown as WindowsShellHost;
}

/** A login script that emits typed events synchronously and resolves only
 *  when the test answers (or cancels) the flow. Prompt events must arrive
 *  one at a time (the host awaits each response before the next prompt),
 *  so multi-prompt flows emit the next prompt from `onRespond`. */
function deferredLogin(events: readonly AuthInteractionEvent[]) {
  let resolver: (result: AuthCommandResult) => void = () => undefined;
  const login = (
    _command: Extract<AuthCommand, { readonly command: "login" }>,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult> => {
    for (const event of events) onInteraction?.(event);
    return new Promise<AuthCommandResult>((resolve) => {
      resolver = resolve;
    });
  };
  const resolveLogin = (result: AuthCommandResult) => resolver(result);
  return { login, resolveLogin };
}

const okState: AuthCommandResult = {
  outcome: "ok",
  state: projection as never,
};
const cancelledState: AuthCommandResult = {
  outcome: "cancelled",
  state: projection as never,
  error: "Sign-in did not complete. Check the Provider's requirements and try again.",
};
const failedState: AuthCommandResult = {
  outcome: "failed",
  state: projection as never,
  error: "Sign-in did not complete. Check the Provider's requirements and try again.",
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

  async function render(shell: WindowsShellHost) {
    act(() => {
      root.render(
        <CredentialsPage credentials={projection as never} shell={shell} />,
      );
    });
    // The mount queries (credential + auth options) resolve asynchronously.
    await act(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  }

  it("queries the authority and the login options on page open; no polling", async () => {
    const commands: CredentialCommand[] = [];
    let authQueries = 0;
    const shell = makeShell({
      credential: async (command) => {
        commands.push(command);
        return { outcome: "ok", revision: 2, state: projection as never };
      },
    });
    // Count the separate auth-options query through a wrapper.
    const wrapped: WindowsShellHost = {
      ...shell,
      executeAuthCommand: (command, onInteraction) => {
        if (command.command === "query") authQueries += 1;
        return shell.executeAuthCommand(command, onInteraction);
      },
    };
    await render(wrapped);
    // The mount queries run exactly once per page open; no polling.
    expect(commands).toEqual([{ command: "query" }]);
    expect(authQueries).toBe(1);
  });

  it("renders the bounded status facts and never credential values", async () => {
    await render(makeShell());
    const text = container.textContent ?? "";
    expect(text).toContain("anthropic");
    expect(text).toContain("stored: API key");
    expect(text).toContain("my-gateway");
    expect(text).toContain("models.json API key");
    expect(text).toContain("auth.json");
    expect(text).not.toContain("sk-");
  });

  it("offers the two exact top-level choices per Provider from metadata only", async () => {
    await render(makeShell());
    const buttons = [...container.querySelectorAll("button")];
    const accountButtons = buttons.filter(
      (entry) => entry.textContent === "Use an account or subscription",
    );
    const apiKeyButtons = buttons.filter(
      (entry) => entry.textContent === "Use an API key",
    );
    // Only the Provider that declares an account flow gets the account
    // choice; both declare API key auth.
    expect(accountButtons).toHaveLength(1);
    expect(apiKeyButtons).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).toContain("Subscription account");
    expect(text).toContain("No account flow");
    expect(text).toContain("API key available");
  });

  it("the API-key choice preselects the Provider in the stored-value form", async () => {
    await render(makeShell());
    const button = [...container.querySelectorAll("button")].find(
      (entry) =>
        entry.textContent === "Use an API key" &&
        entry.closest(".settings-row")?.textContent?.includes("My Gateway"),
    );
    await act(async () => {
      button?.click();
    });
    const select = container.querySelector(
      ".settings-group select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("my-gateway");
  });

  it("stores a literal API key through the authority seam", async () => {
    const commands: CredentialCommand[] = [];
    const shell = makeShell({
      credential: async (command) => {
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
      },
    });
    await render(shell);
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
    const shell = makeShell({
      credential: async (command) => {
        commands.push(command);
        return {
          outcome: "ok",
          revision: 3,
          changed: true,
          state: projection as never,
        };
      },
    });
    await render(shell);
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
    const shell = makeShell({
      credential: async () => ({
        outcome: "conflict",
        revision: 3,
        state: projection as never,
        error: "Credential state changed; re-query and retry",
      }),
    });
    await render(shell);
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

  it("runs the account login with providerId oauth and no provider branches", async () => {
    const logins: Array<
      Extract<AuthCommand, { readonly command: "login" }>
    > = [];
    const { login, resolveLogin } = deferredLogin([
      { type: "progress", message: "Preparing sign-in…" },
      {
        type: "auth_url",
        url: "https://example.com/authorize?client=fake",
        instructions: "Sign in with your account.",
      },
    ]);
    const shell = makeShell({
      onLogin: (command, onInteraction) => {
        logins.push(command);
        return login(command, onInteraction);
      },
    });
    await render(shell);
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Use an account or subscription",
    );
    await act(async () => {
      button?.click();
    });
    expect(logins).toEqual([
      { command: "login", providerId: "anthropic", authType: "oauth" },
    ]);
    // The typed events project into the panel: the URL is visible (input
    // value) and the instructions are shown.
    const text = container.textContent ?? "";
    expect(text).toContain("Preparing sign-in…");
    const urlInput = container.querySelector(
      ".auth-flow-url input",
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com/authorize?client=fake");
    expect(text).toContain("Sign in with your account.");
    expect(text).toContain("If the browser does not open, copy the URL");
    // The terminal outcome ends the flow with success.
    await act(async () => {
      resolveLogin(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain("Signed in to anthropic.");
  });

  it("auto-opens a newly received browser URL and keeps the copyable fallback", async () => {
    const opened: string[] = [];
    let clipboardText: string | undefined;
    const clipboardWrite = vi.fn().mockImplementation((text: string) => {
      clipboardText = text;
      return Promise.resolve();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const { login, resolveLogin } = deferredLogin([
      { type: "auth_url", url: "https://example.com/device" },
    ]);
    const shell = makeShell({
      onLogin: login,
      onOpenUrl: async (url) => {
        opened.push(url);
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    // The newly received auth_url event auto-opens the OS seam exactly
    // once; the manual controls still work as the fallback.
    expect(opened).toEqual(["https://example.com/device"]);
    await act(async () => {
      const open = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Open in browser",
      );
      open?.click();
      const copy = [...container.querySelectorAll("button")].find(
        (entry) => entry.textContent === "Copy",
      );
      copy?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(opened).toEqual([
      "https://example.com/device",
      "https://example.com/device",
    ]);
    expect(clipboardText).toBe("https://example.com/device");
    // The URL itself is visible in the panel (manual fallback).
    const urlInput = container.querySelector(
      ".auth-flow-url input",
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com/device");
    await act(async () => {
      resolveLogin(cancelledState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  });

  it("auto-opens exactly once per new URL event and never on re-renders", async () => {
    const opened: string[] = [];
    const { login, resolveLogin } = deferredLogin([
      { type: "auth_url", url: "https://example.com/authorize" },
      {
        type: "prompt",
        promptId: "p1",
        kind: "text",
        message: "Enter the code",
      },
    ]);
    const shell = makeShell({
      onLogin: login,
      onOpenUrl: async (url) => {
        opened.push(url);
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    expect(opened).toEqual(["https://example.com/authorize"]);
    // Interacting with the prompt re-renders the panel; the URL must not
    // be opened again by any render or effect.
    await act(async () => {
      const input = container.querySelector(
        ".auth-flow-prompt-form input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(opened).toEqual(["https://example.com/authorize"]);
    await act(async () => {
      resolveLogin(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(opened).toEqual(["https://example.com/authorize"]);
  });

  it("a failed automatic open never fails the flow and shows the manual-fallback note", async () => {
    const { login, resolveLogin } = deferredLogin([
      { type: "auth_url", url: "https://example.com/authorize" },
      {
        type: "prompt",
        promptId: "p1",
        kind: "text",
        message: "Enter the code",
      },
    ]);
    const shell = makeShell({
      onLogin: login,
      onOpenUrl: async () => {
        throw new Error("no browser available");
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    // The concise note guides the user; the flow is still live and the
    // URL row with the manual Open/Copy controls stays visible.
    expect(container.textContent).toContain(
      "Could not open the URL automatically. Copy it and open it manually.",
    );
    const urlInput = container.querySelector(
      ".auth-flow-url input",
    ) as HTMLInputElement;
    expect(urlInput.value).toBe("https://example.com/authorize");
    const manual = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Open in browser",
    );
    expect(manual).not.toBeUndefined();
    expect(
      [...container.querySelectorAll("button")].some(
        (entry) => entry.textContent === "Submit",
      ),
    ).toBe(true);
    await act(async () => {
      resolveLogin(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain("Signed in to anthropic.");
  });

  it("a concurrent login refusal surfaces the actionable conflict message", async () => {
    const shell = makeShell({
      onLogin: () =>
        Promise.reject(
          new Error(
            "Another sign-in is already in progress. Wait for it to finish, then try again.",
          ),
        ),
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain(
      "Another sign-in is already in progress.",
    );
  });

  it("projects device-code flows with the user code and verification page", async () => {
    const opened: string[] = [];
    const { login, resolveLogin } = deferredLogin([
      {
        type: "device_code",
        userCode: "FAKE-USER-CODE",
        verificationUri: "https://example.com/verify",
        intervalSeconds: 5,
        expiresInSeconds: 300,
      },
    ]);
    const shell = makeShell({
      onLogin: login,
      onOpenUrl: async (url) => {
        opened.push(url);
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("FAKE-USER-CODE");
    expect(text).toContain("The code expires in 300 seconds; poll every 5");
    // The newly received device_code event auto-opened the verification
    // page exactly once; the manual button opens it again on demand.
    expect(opened).toEqual(["https://example.com/verify"]);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Open verification page")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(opened).toEqual([
      "https://example.com/verify",
      "https://example.com/verify",
    ]);
    await act(async () => {
      resolveLogin(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  });

  it("answers a select prompt with the chosen option id", async () => {
    const responses: AuthInteractionResponse[] = [];
    const { login, resolveLogin } = deferredLogin([
      {
        type: "prompt",
        promptId: "select-1",
        kind: "select",
        message: "Choose your region",
        options: [
          { id: "us", label: "United States" },
          { id: "eu", label: "Europe" },
        ],
      },
    ]);
    const shell = makeShell({
      onLogin: login,
      onRespond: async (response) => {
        responses.push(response);
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    expect(container.textContent).toContain("Choose your region");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Europe")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(responses).toEqual([
      { type: "prompt_response", promptId: "select-1", value: "eu" },
    ]);
    await act(async () => {
      resolveLogin(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  });

  it("submits text and secret prompt answers without rendering values back", async () => {
    const responses: AuthInteractionResponse[] = [];
    // Host semantics: one prompt at a time — the second prompt is emitted
    // only after the first response is routed back.
    let resolver: (result: AuthCommandResult) => void = () => undefined;
    let onInteractionRef:
      | ((event: AuthInteractionEvent) => void)
      | undefined;
    let secondEmitted = false;
    const shell = makeShell({
      onLogin: (_command, onInteraction) => {
        onInteractionRef = onInteraction;
        onInteraction?.({
          type: "prompt",
          promptId: "text-1",
          kind: "text",
          message: "Enter the code from the email",
          placeholder: "6 digits",
        });
        return new Promise<AuthCommandResult>((resolve) => {
          resolver = resolve;
        });
      },
      onRespond: async (response) => {
        responses.push(response);
        if (
          response.type === "prompt_response" &&
          response.promptId === "text-1" &&
          !secondEmitted
        ) {
          secondEmitted = true;
          onInteractionRef?.({
            type: "prompt",
            promptId: "secret-1",
            kind: "secret",
            message: "Enter your secret key",
          });
        }
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    // Text prompt: type and submit.
    await act(async () => {
      const input = container.querySelector(
        ".auth-flow-prompt-form input",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Submit")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(responses).toEqual([
      { type: "prompt_response", promptId: "text-1", value: "123456" },
    ]);
    // Secret prompt: the input is masked and the value never renders.
    await act(async () => {
      const input = container.querySelector(
        ".auth-flow-prompt-form input",
      ) as HTMLInputElement;
      expect(input.type).toBe("password");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "super-secret-value");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Submit")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(responses).toHaveLength(2);
    expect(responses[1]).toEqual({
      type: "prompt_response",
      promptId: "secret-1",
      value: "super-secret-value",
    });
    expect(container.textContent).not.toContain("super-secret-value");
    await act(async () => {
      resolver(okState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  });

  it("cancel routes the cancel response and shows the cancelled terminal", async () => {
    const responses: AuthInteractionResponse[] = [];
    const { login, resolveLogin } = deferredLogin([
      {
        type: "prompt",
        promptId: "p-cancel",
        kind: "text",
        message: "Enter the code",
      },
    ]);
    const shell = makeShell({
      onLogin: login,
      onRespond: async (response) => {
        responses.push(response);
      },
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Cancel sign-in")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(responses).toEqual([{ type: "cancel" }]);
    await act(async () => {
      resolveLogin(cancelledState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain("Sign-in cancelled.");
  });

  it("shows the value-free failure and never the raw error text", async () => {
    const { login, resolveLogin } = deferredLogin([
      { type: "info", message: "Opening the Provider page…" },
    ]);
    const shell = makeShell({ onLogin: login });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
    });
    expect(container.textContent).toContain("Opening the Provider page…");
    await act(async () => {
      resolveLogin(failedState);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain(
      "Sign-in did not complete. Check the Provider's requirements and try again.",
    );
  });

  it("a transport failure surfaces as an error and closes the flow", async () => {
    const shell = makeShell({
      onLogin: () => Promise.reject(new Error("LuckyToken connection lost")),
    });
    await render(shell);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Use an account or subscription")
        ?.click();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
    expect(container.textContent).toContain("LuckyToken connection lost");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((entry) => entry.textContent === "Close")
        ?.click();
    });
    expect(container.textContent).not.toContain("Sign in to anthropic");
  });
});
