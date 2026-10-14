export const reportFilename = (name: string, extension: 'html' | 'md') => {
  const stem = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[.\s]+$/g, '').trim();
  return `${stem || '调查报告'}.${extension}`;
};

export const downloadReportFile = (contents: string, name: string, extension: 'html' | 'md') => {
  const type = extension === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8';
  const url = URL.createObjectURL(new Blob([contents], {type}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = reportFilename(name, extension);
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Chromium needs the blob while it opens the native save dialog.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};
