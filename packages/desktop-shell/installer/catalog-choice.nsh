!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var CatalogOverwrite
Var CatalogCheckbox

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 Token"
  !define MUI_WELCOMEPAGE_TEXT "本向导将安装 Token，并在安装前让你选择是否更新 CommandCode 模型目录。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  StrCpy $CatalogOverwrite ${BST_CHECKED}
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

!macro customPageAfterChangeDir
  Page custom CatalogPageCreate CatalogPageLeave
!macroend

Function CatalogPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0u 0u 100% 30u "CommandCode 模型目录"
  Pop $0
  ${NSD_CreateCheckbox} 0u 35u 100% 18u "覆盖用户目录中的 commandcode-models.json（推荐）"
  Pop $CatalogCheckbox
  ${NSD_Check} $CatalogCheckbox
  ${NSD_CreateLabel} 0u 62u 100% 48u "选中时将安装包内的模型目录复制到你的 .Token 目录。取消勾选会保留现有文件；若文件缺失，Token 首次启动时仍会创建默认目录。"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function CatalogPageLeave
  ${NSD_GetState} $CatalogCheckbox $CatalogOverwrite
FunctionEnd

!macro customInstall
  ${If} $CatalogOverwrite == ${BST_CHECKED}
    CreateDirectory "$PROFILE\.Token"
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\resources\backend\node_modules\@token\commandcode-model-catalog\commandcode-models.json" "$PROFILE\.Token\commandcode-models.json"
    ${If} ${Errors}
      Abort "无法更新 commandcode-models.json"
    ${EndIf}
  ${EndIf}
!macroend
