!include "LogicLib.nsh"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 Token"
  !define MUI_WELCOMEPAGE_TEXT "本向导将安装 Token，并使用当前版本内置的 CommandCode 模型目录更新用户目录。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ${If} ${FileExists} "$LOCALAPPDATA\Token\Update.exe"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "检测到旧版 Squirrel 安装。请先从 Windows 应用列表卸载旧版 Token，然后重新运行安装包。用户目录中的配置会保留。"
    ${EndIf}
    Abort
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
  StrCpy $isForceMachineInstall "0"
!macroend

!macro customInstall
  CreateDirectory "$PROFILE\.Token"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\resources\backend\node_modules\@token\commandcode-model-catalog\commandcode-models.json" "$PROFILE\.Token\commandcode-models.json"
  ${If} ${Errors}
    Abort "无法更新 commandcode-models.json"
  ${EndIf}
!macroend
