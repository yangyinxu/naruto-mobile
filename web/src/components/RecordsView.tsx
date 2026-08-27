import {FormEvent, useEffect, useState} from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  FileJson,
  FolderOpen,
  LoaderCircle,
  MessageSquareText,
  Search,
  Video
} from 'lucide-react';
import {api} from '../lib/api';
import {ContentRecord, OpinionRecord, RunManifest, RunRecordsResponse} from '../types';

interface Props {
  run: RunManifest;
  onBack: () => void;
  onError: (message: string) => void;
}

const pageSize = 50;
const sourceLabels: Record<OpinionRecord['sourceType'], string> = {
  comment: '评论',
  reply: '回复',
  danmaku: '弹幕',
  creator_view: '创作者观点'
};

const displayTime = (value?: string, fallback?: string) => {
  if (!value) return fallback || '页面未记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN');
};

const OpinionCard = ({record, contentTitle}: {record: OpinionRecord; contentTitle?: string}) => (
  <article className="record-card opinion-record">
    <header>
      <div className="record-author">
        <strong>{record.authorName || (record.voiceType === 'creator' ? '创作者标题' : '旧版未记录用户名')}</strong>
        <span>{record.authorUid ? `UID ${record.authorUid}` : record.voiceType === 'viewer' ? 'UID 未记录' : '创作者内容'}</span>
      </div>
      <span className="record-kind">{sourceLabels[record.sourceType]}</span>
    </header>
    <p className="record-text">{record.text}</p>
    <dl className="record-fields">
      <div><dt>来源内容</dt><dd>{contentTitle || record.contentId}</dd></div>
      <div><dt>评论 ID</dt><dd>{record.sourceRecordId || '旧版未记录'}</dd></div>
      {record.parentSourceRecordId && <div><dt>父评论 ID</dt><dd>{record.parentSourceRecordId}</dd></div>}
      <div><dt>发布时间</dt><dd>{displayTime(record.publishedAt, record.publishedAtText)}</dd></div>
      <div><dt>采集时间</dt><dd>{displayTime(record.collectedAt)}</dd></div>
      <div><dt>互动</dt><dd>{record.likes} 赞 · {record.replies} 回复</dd></div>
    </dl>
    <div className="record-links">
      {record.authorProfileUrl && <a href={record.authorProfileUrl} target="_blank" rel="noreferrer"><ExternalLink size={15}/>用户主页</a>}
      <a href={record.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={15}/>打开原评论</a>
      {record.sourcePageUrl && record.sourcePageUrl !== record.sourceUrl && <a href={record.sourcePageUrl} target="_blank" rel="noreferrer"><Video size={15}/>打开原内容</a>}
    </div>
    <details className="raw-record"><summary><FileJson size={15}/>查看完整 JSON 记录</summary><pre>{JSON.stringify(record, null, 2)}</pre></details>
  </article>
);

const ContentCard = ({record}: {record: ContentRecord}) => (
  <article className="record-card content-record">
    <header><div className="record-author"><strong>{record.title}</strong><span>{record.type === 'video' ? '视频' : '动态'} · {record.id}</span></div><span className="record-kind">来源</span></header>
    {record.description && <p className="record-description">{record.description}</p>}
    <dl className="record-fields">
      <div><dt>发现关键词</dt><dd>{record.discoveryKeyword || '未记录'}</dd></div>
      <div><dt>发现顺序</dt><dd>第 {record.discoveryRank} 条</dd></div>
      <div><dt>发布时间</dt><dd>{displayTime(record.publishedAt)}</dd></div>
      <div><dt>采集时间</dt><dd>{displayTime(record.collectedAt)}</dd></div>
      <div><dt>公开数据</dt><dd>{record.metrics.views ?? 0} 播放 · {record.metrics.comments ?? 0} 评论</dd></div>
    </dl>
    <div className="record-links"><a href={record.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>打开原内容</a>{record.discoveryUrl && <a href={record.discoveryUrl} target="_blank" rel="noreferrer"><Search size={15}/>打开发现页面</a>}</div>
    <details className="raw-record"><summary><FileJson size={15}/>查看完整 JSON 记录</summary><pre>{JSON.stringify(record, null, 2)}</pre></details>
  </article>
);

export const RecordsView = ({run, onBack, onError}: Props) => {
  const [kind, setKind] = useState<'opinions' | 'contents'>('opinions');
  const [page, setPage] = useState(0);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<RunRecordsResponse>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.runRecords(run.id, kind, page * pageSize, pageSize, query)
      .then((result) => { if (active) setData(result); })
      .catch((error) => { if (active) onError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, onError, page, query, run.id]);

  const chooseKind = (next: 'opinions' | 'contents') => {
    setKind(next);
    setPage(0);
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    setPage(0);
    setQuery(queryInput.trim());
  };
  const total = data?.kind === kind ? data.total : 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="records-page content-width">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17}/> 返回历史调查</button>
      <section className="records-header">
        <div><span className="eyebrow"><Database size={15}/> 明文调查档案</span><h1>{run.request.name}</h1><p>逐条浏览完整采集记录；展开可查看原始 JSON，来源链接可直接核查。</p></div>
        <button className="secondary-action" onClick={() => void api.openFolder(run.id).catch((error) => onError(error.message))}><FolderOpen size={17}/>打开完整记录文件夹</button>
      </section>

      <section className="records-toolbar">
        <div className="record-tabs" role="tablist" aria-label="记录类型">
          <button className={kind === 'opinions' ? 'active' : ''} onClick={() => chooseKind('opinions')}><MessageSquareText size={17}/>意见记录 <b>{run.counts.opinions}</b></button>
          <button className={kind === 'contents' ? 'active' : ''} onClick={() => chooseKind('contents')}><Video size={17}/>来源记录 <b>{run.counts.contents}</b></button>
        </div>
        <form className="record-search" onSubmit={search}>
          <Search size={17}/><input aria-label="搜索完整记录" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索用户名、UID、评论、评论 ID或视频"/><button type="submit">搜索</button>
        </form>
      </section>

      <div className="records-summary"><span>{query ? `“${query}”找到 ${total} 条` : `共 ${total} 条${kind === 'opinions' ? '意见' : '来源'}记录`}</span><span>第 {Math.min(page + 1, pageCount)} / {pageCount} 页</span></div>

      {loading ? (
        <div className="records-loading"><LoaderCircle className="spin"/><span>正在读取完整记录…</span></div>
      ) : total === 0 ? (
        <div className="empty-state compact"><FileJson size={38}/><h2>没有找到记录</h2><p>{query ? '换一个关键词试试。' : '这次调查还没有写入该类型的数据。'}</p></div>
      ) : (
        <div className="record-list">
          {data?.kind === 'opinions' && data.records.map(({record, contentTitle}) => <OpinionCard key={record.id} record={record} contentTitle={contentTitle}/>)}
          {data?.kind === 'contents' && data.records.map((record) => <ContentCard key={record.id} record={record}/>)}
        </div>
      )}

      {total > pageSize && <nav className="records-pagination" aria-label="完整记录分页"><button disabled={page === 0 || loading} onClick={() => setPage((current) => Math.max(0, current - 1))}><ChevronLeft size={17}/>上一页</button><span>每页 {pageSize} 条</span><button disabled={page + 1 >= pageCount || loading} onClick={() => setPage((current) => current + 1)}>下一页<ChevronRight size={17}/></button></nav>}
    </main>
  );
};
