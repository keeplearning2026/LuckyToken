; LuckyToken NSIS installer hooks.
;
; Ticket 26 hardening: Tauri's stock uninstaller only clears the saved
; install-location key (${MANUPRODUCTKEY}) when the user opts to delete
; application data. A silent uninstall therefore leaves the key behind, so
; the next install restores the previous (possibly temporary or custom)
; directory via RestorePreviousInstallLocation. This hook unconditionally
; removes the install-location memory on uninstall. The key holds only the
; last install directory and installer language; the user's data root
; (%USERPROFILE%\.luckytoken) is untouched.

!macro NSIS_HOOK_PREUNINSTALL
  ; Run before the stock uninstaller deletes files and registry entries.
  ; ${MANUPRODUCTKEY} is Software\<manufacturer>\<productName> and
  ; ${MANUKEY} is its parent, both defined by the Tauri NSIS template.
  DeleteRegKey HKCU "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty HKCU "${MANUKEY}"
!macroend
