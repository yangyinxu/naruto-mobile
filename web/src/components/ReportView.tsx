import {useEffect, useState} from 'react';
import {ArrowLeft, Download, FolderOpen, LoaderCircle} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {api} from '../lib/api';
import {RunManifest} from '../types';

export const ReportView = ({run, onBack, onError}: {
  run: RunManifest;
  onBack: () => void;
  onError: (message: string) => void;
}) => {
  const [markdown, setMarkdown] = useState('');
  useEffect(() => {
    void api.report(run.id).then(setMarkdown).catch((error) => onError(error.message));
  }, [run.id, onError]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${run.request.name.replace(/[\\/:*?"<>|]/g, '-')}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="report-page">
      <div className="report-toolbar content-width"><button className="back-button" onClick={onBack}><ArrowLeft size={17}/>返回调查</button><div><button className="secondary-action" onClick={() => void api.openFolder(run.id)}><FolderOpen size={17}/>打开文件夹</button><button className="primary-small" disabled={!markdown} onClick={download}><Download size={17}/>导出 Markdown</button></div></div>
      <article className="markdown-report">
        {markdown ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown> : <div className="report-loading"><LoaderCircle className="spin"/><span>正在读取本地报告…</span></div>}
      </article>
    </main>
  );
};
