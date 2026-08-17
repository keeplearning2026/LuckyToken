export interface ManagementWindowHandle {
  focus(): void;
  destroy(): void;
}

export interface ManagementWindowLifecycleDependencies {
  readonly createWindow: () => ManagementWindowHandle;
}

export interface ManagementWindowLifecycle {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function createManagementWindowLifecycle(
  dependencies: ManagementWindowLifecycleDependencies,
): ManagementWindowLifecycle {
  let current: ManagementWindowHandle | undefined;

  return Object.freeze({
    open(): void {
      if (current !== undefined) {
        current.focus();
        return;
      }
      current = dependencies.createWindow();
    },
    close(): void {
      const window = current;
      current = undefined;
      window?.destroy();
    },
    isOpen(): boolean {
      return current !== undefined;
    },
  });
}
