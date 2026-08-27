import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

const cancelled = (error: unknown) => (
  (error as NodeJS.ErrnoException).code === '1'
  || (error as {code?: number}).code === 1
);

const chooseOnWindows = async (currentRoot: string) => {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择调查文件的存放位置'
$dialog.ShowNewFolderButton = $true
if (Test-Path -LiteralPath $env:NARUTO_CURRENT_DATA_ROOT) {
  $dialog.SelectedPath = $env:NARUTO_CURRENT_DATA_ROOT
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const {stdout} = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    env: {...process.env, NARUTO_CURRENT_DATA_ROOT: currentRoot},
    windowsHide: true
  });
  return stdout.trim() || null;
};

const chooseOnMac = async () => {
  try {
    const {stdout} = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "选择调查文件的存放位置")'
    ], {encoding: 'utf8'});
    return stdout.trim() || null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
};

const chooseOnLinux = async (currentRoot: string) => {
  try {
    const {stdout} = await execFileAsync('zenity', [
      '--file-selection',
      '--directory',
      '--title=选择调查文件的存放位置',
      `--filename=${currentRoot}/`
    ], {encoding: 'utf8'});
    return stdout.trim() || null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
};

/** Opens the operating system's folder chooser and returns no path when the user cancels. */
export const chooseDataDirectory = async (currentRoot: string) => {
  if (process.platform === 'win32') return chooseOnWindows(currentRoot);
  if (process.platform === 'darwin') return chooseOnMac();
  return chooseOnLinux(currentRoot);
};
