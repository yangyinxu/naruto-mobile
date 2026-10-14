import {useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft,
  Download,
  FolderOpen,
  LoaderCircle
} from 'lucide-react';
import {api} from '../lib/api';
import {ReportDossier} from './ReportDossier';
import {downloadReportFile} from '../lib/downloadReport';
import {ReportData, ReportSentiment, RunManifest} from '../types';

const sentiments: ReportSentiment[] = ['positive', 'mixed', 'negative', 'neutral'];

export const ReportView = ({run, onBack, onError}: {
  run: RunManifest;
  onBack: () => void;
  onError: (message: string) => void;
}) => {
  const [markdown, setMarkdown] = useState('');
  const [data, setData] = useState<ReportData>();
  const [selectedTopic, setSelectedTopic] = useState('');
  const [selectedSentiment, setSelectedSentiment] = useState<ReportSentiment>('negative');
  const [exportingHtml, setExportingHtml] = useState(false);

  useEffect(() => {
    void Promise.all([api.report(run.id), api.reportData(run.id)])
      .then(([reportMarkdown, reportData]) => {
        setMarkdown(reportMarkdown);
        setData(reportData);
        setSelectedTopic(reportData.topics[0]?.topic ?? '');
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [run.id, onError]);

  const topic = useMemo(() => data?.topics.find((item) => item.topic === selectedTopic)
    ?? data?.topics[0], [data, selectedTopic]);

  useEffect(() => {
    if (!topic || topic.evidence[selectedSentiment].length > 0) return;
    const next = sentiments.find((item) => topic.evidence[item].length > 0);
    if (next) setSelectedSentiment(next);
  }, [topic, selectedSentiment]);

  const downloadHtml = async () => {
    if (!data || exportingHtml) return;
    setExportingHtml(true);
    try {
      const {buildHtmlReport} = await import('../lib/htmlReport');
      downloadReportFile(buildHtmlReport(run.request.name, data), run.request.name, 'html');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingHtml(false);
    }
  };

  const selectTopic = (name: string) => {
    setSelectedTopic(name);
    setSelectedSentiment('negative');
    (document.querySelector('.report-topic-detail') as HTMLElement | null)?.scrollTo?.({top: 0, behavior: 'smooth'});
  };

  if (!data) {
    return <main className="report-page"><div className="report-loading"><LoaderCircle className="spin"/><span>正在整理主题与完整证据…</span></div></main>;
  }

  return (
    <main className="report-page">
      <div className="report-toolbar content-width">
        <button className="back-button" onClick={onBack}><ArrowLeft size={17}/>返回调查</button>
        <div>
          {import.meta.env.MODE === 'hosted'
            ? <button className="secondary-action" onClick={() => void api.exportRun(run.id).catch((error) => onError(error.message))}><Download size={17}/>导出调查 ZIP</button>
            : <button className="secondary-action" onClick={() => void api.openFolder(run.id).catch((error) => onError(error.message))}><FolderOpen size={17}/>打开文件夹</button>}
          <button className="secondary-action" disabled={!markdown} onClick={() => downloadReportFile(markdown, run.request.name, 'md')}><Download size={17}/>导出 Markdown</button>
          <button className="primary-small" disabled={exportingHtml} onClick={() => void downloadHtml()} title="保存为单个 HTML 文件，含样式和交互，浏览器可离线打开">{exportingHtml ? <LoaderCircle className="spin" size={17}/> : <Download size={17}/>}导出 HTML</button>
        </div>
      </div>

      <ReportDossier title={run.request.name} data={data} selectedTopic={selectedTopic} selectedSentiment={selectedSentiment} onSelectTopic={selectTopic} onSelectSentiment={setSelectedSentiment}/>
    </main>
  );
};
