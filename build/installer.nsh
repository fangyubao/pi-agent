; NSIS does not consume build.protocols (AppX/macOS do). Register the
; app-owned scheme for the current installation scope explicitly.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\pi-workbench" "" "URL:Pi Workbench"
  WriteRegStr SHELL_CONTEXT "Software\Classes\pi-workbench" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\pi-workbench\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\pi-workbench\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; Do not remove a handler that another installation has taken over.
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\pi-workbench\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
  DeleteRegKey SHELL_CONTEXT "Software\Classes\pi-workbench"
!macroend
