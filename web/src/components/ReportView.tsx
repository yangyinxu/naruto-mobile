import {useEffect, useMemo, useState} from 'react';
import {
  ArrowLeft,
  ChevronRight,
  CircleDollarSign,
  Download,
  ExternalLink,
  FileStack,
  FolderOpen,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  UsersRound
} from 'lucide-react';
import {api} from '../lib/api';
import {ReportData, ReportSentiment, RunManifest} from '../types';

const sentiments: Array<{
  key: ReportSentiment;
  label: string;
  Icon: typeof ThumbsUp;
}> = [
  {key: 'positive', label: '正向', Icon: ThumbsUp},
  {key: 'mixed', label: '混合', Icon: MessageSquareText},
  {key: 'negative', label: '负向', Icon: ThumbsDown},
  {key: 'neutral', label: '中性', Icon: MessageSquareText}
];

const number = (value: number) => value.toLocaleString('zh-CN');
const cost = (value?: number) => value === undefined
  ? '暂无法估算'
  : `约 $${value < 0.01 ? value.toFixed(4) : value.toFixed(2)} 美元`;
const severity = (value: number) => value >= 4 ? '严重'
  : value >= 3 ? '较高' : value >= 2 ? '中等' : '轻微';

export const ReportView = ({run, onBack, onError}: {
  run: RunManifest;
  onBack: () => void;
  onError: (message: string) => void;
}) => {
  const [markdown, setMarkdown] = useState('');
  const [data, setData] = useState<ReportData>();
  const [selectedTopic, setSelectedTopic] = useState('');
  const [selectedSentiment, setSelectedSentiment] = useState<ReportSentiment>('negative');

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
    const next = sentiments.find((item) => topic.evidence[item.key].length > 0);
    if (next) setSelectedSentiment(next.key);
  }, [topic, selectedSentiment]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${run.request.name.replace(/[\\/:*?"<>|]/g, '-')}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const selectTopic = (name: string) => {
    setSelectedTopic(name);
    setSelectedSentiment('negative');
    (document.querySelector('.report-topic-detail') as HTMLElement | null)?.scrollTo?.({top: 0, behavior: 'smooth'});
  };

  if (!data) {
    return <main className="report-page"><div className="report-loading"><LoaderCircle className="spin"/><span>正在整理主题与完整证据…</span></div></main>;
  }

  const usage = data.quality.usage;
  const activeEvidence = topic?.evidence[selectedSentiment] ?? [];

  return (
    <main className="report-page">
      <div className="report-toolbar content-width">
        <button className="back-button" onClick={onBack}><ArrowLeft size={17}/>返回调查</button>
        <div>
          <button className="secondary-action" onClick={() => void api.openFolder(run.id).catch((error) => onError(error.message))}><FolderOpen size={17}/>打开文件夹</button>
          <button className="primary-small" disabled={!markdown} onClick={download}><Download size={17}/>导出完整报告</button>
        </div>
      </div>

      <section className="report-dossier content-width">
        <header className="report-hero">
          <div>
            <span className="report-kicker">调查报告 · {data.quality.analysisLabel}</span>
            <h1>{run.request.name}</h1>
            <p>{data.conclusion}</p>
          </div>
          <div className="report-confidence">
            <ShieldCheck aria-hidden="true"/>
            <span>样本判断</span>
            <strong>{data.sample.confidenceLabel}</strong>
            <small>{data.sample.confidenceExplanation}</small>
          </div>
        </header>

        <div className="report-overview" aria-label="报告概况">
          <div><FileStack/><span>独立来源</span><strong>{number(data.sample.sourceCount)}</strong><small>个公开页面</small></div>
          <div><MessageSquareText/><span>报告采用意见</span><strong>{number(data.sample.validOpinions)}</strong><small>条观众记录，清理去重后入选</small></div>
          <div><UsersRound/><span>主题数量</span><strong>{number(data.sample.topicCount)}</strong><small>个可查看详情</small></div>
          <div><CircleDollarSign/><span>AI 预估总费用</span><strong>{data.quality.analysisMode === 'rule_demo' ? '$0.00' : usage ? cost(usage.estimatedCostUsd).replace('约 ', '').replace(' 美元', '') : '未记录'}</strong><small>{data.quality.analysisMode === 'rule_demo' ? '演示模式未调用' : usage ? `${number(usage.totalTokens)} Token` : '旧版报告无法还原'}</small></div>
        </div>

        <div className="report-workspace">
          <aside className="report-topic-nav" aria-label="主题档案导航">
            <div className="report-panel-heading">
              <div><span>主题档案</span><strong>先看总结，再看证据</strong></div>
              <em>{data.topics.length} 个主题</em>
            </div>
            <div className="report-topic-list">
              {data.topics.map((item) => (
                <button
                  key={item.topic}
                  className={item.topic === topic?.topic ? 'active' : ''}
                  onClick={() => selectTopic(item.topic)}
                  aria-current={item.topic === topic?.topic ? 'true' : undefined}
                >
                  <span className="topic-row-title"><strong>{item.topic}</strong><em>{item.count} 条证据</em></span>
                  <span className="topic-row-summary">{item.summary}</span>
                  <span className="topic-row-sentiments">
                    <i className="positive">正 {item.positive}</i>
                    <i className="mixed">混 {item.mixed}</i>
                    <i className="negative">负 {item.negative}</i>
                    {item.neutral > 0 && <i className="neutral">中 {item.neutral}</i>}
                  </span>
                  <span className="topic-row-link">查看完整详情 <ChevronRight/></span>
                </button>
              ))}
              {data.topics.length === 0 && <p className="report-empty">暂无达到报告门槛的主题。</p>}
            </div>
          </aside>

          <section className="report-topic-detail" aria-live="polite">
            {topic ? <>
              <header className="topic-detail-header">
                <span className="topic-seal">主题 {data.topics.findIndex((item) => item.topic === topic.topic) + 1}</span>
                <h2>{topic.topic}</h2>
                <p>{topic.summary}</p>
                <div className="topic-evidence-scope">
                  <span><UsersRound/> {topic.authors} 名可区分作者</span>
                  <span><FileStack/> {topic.sources} 个来源</span>
                  <span><ShieldCheck/> {topic.reviewStatus}</span>
                </div>
                <p className="report-count-scope">本主题证据 {topic.count} 条 = 正向 {topic.positive} + 混合 {topic.mixed} + 负向 {topic.negative} + 中性 {topic.neutral}。同一条意见可属于多个主题，各主题证据数不能相加当作全报告意见数。作者按可见账号信息区分，无法识别的作者按记录区分；来源按独立页面计数。</p>
              </header>

              <div className="sentiment-tabs" role="tablist" aria-label={`${topic.topic}意见分类`}>
                {sentiments.filter((item) => item.key !== 'neutral' || topic.neutral > 0).map(({key, label, Icon}) => (
                  <button
                    key={key}
                    className={`sentiment-${key} ${selectedSentiment === key ? 'active' : ''}`}
                    role="tab"
                    aria-selected={selectedSentiment === key}
                    onClick={() => setSelectedSentiment(key)}
                  ><Icon/>{label}<strong>{topic[key]}</strong></button>
                ))}
              </div>

              <div className="evidence-heading">
                <div><strong>{sentiments.find((item) => item.key === selectedSentiment)?.label}意见</strong><span>完整展示当前主题、当前情绪的 {activeEvidence.length} 条证据</span></div>
                <small>按点赞数与严重度排序</small>
              </div>
              <div className="evidence-list">
                {activeEvidence.map((item, index) => (
                  <article className={`evidence-item sentiment-${selectedSentiment}`} key={item.id}>
                    <span className="evidence-index">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <blockquote>{item.text}</blockquote>
                      {item.claim && item.claim !== item.text && <p className="evidence-claim"><strong>Luna 提炼：</strong>{item.claim}</p>}
                      <footer>
                        <span>{item.authorName}</span>
                        <span>{item.sourceTitle}</span>
                        <span>{item.likes} 赞 · {item.replies} 回复</span>
                        <span className="severity-label">严重度：{severity(item.severity)}（{item.severity}/5）</span>
                        {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看原文<ExternalLink/></a>}
                      </footer>
                    </div>
                  </article>
                ))}
                {activeEvidence.length === 0 && <div className="report-empty">此主题暂无{sentiments.find((item) => item.key === selectedSentiment)?.label}意见。</div>}
              </div>
            </> : <div className="report-empty">本次没有可展示的主题详情。</div>}
          </section>

          <aside className="report-quality" aria-label="数据质量与 Luna 用量">
            <div className="report-panel-heading"><div><span>质量与费用</span><strong>这些数字意味着什么</strong></div></div>
            <section>
              <h3><ShieldCheck/>数据质量</h3>
              <dl>
                <div><dt>进入报告</dt><dd>{number(data.sample.validOpinions)} 条<strong>已通过采用条件的观众意见</strong></dd></div>
                <div><dt>{data.quality.analysisMode === 'ai' ? '全部强洞察' : '演示有效意见'}</dt><dd>{number(data.quality.strongOpinions)} 条<strong>需要复核的强洞察不自动入选</strong></dd></div>
                <div><dt>弱信号</dt><dd>{number(data.quality.weakOpinions)} 条<strong>保留，不进结论</strong></dd></div>
                <div><dt>无参考价值</dt><dd>{number(data.quality.noiseOpinions)} 条<strong>已排除</strong></dd></div>
                <div><dt>来源覆盖</dt><dd>{number(data.sample.sourceCount)} 个<strong>独立公开页面</strong></dd></div>
              </dl>
              <p className="quality-explanation">已分类观众记录 {number(data.quality.strongOpinions + data.quality.weakOpinions + data.quality.noiseOpinions)} = 强洞察 {number(data.quality.strongOpinions)} + 弱信号 {number(data.quality.weakOpinions)} + 无参考价值 {number(data.quality.noiseOpinions)}。三项互不重叠；作者观点另列，采用数量可能少于全部强洞察。</p>
              <p className="quality-explanation">原始采集 {number(data.sample.rawOpinions)} 条，包含作者观点且尚未清理去重。重复清理 {number(data.quality.duplicateOpinions)} 条；作者观点排除 {number(data.quality.creatorViewsExcluded)} 条；本地无信息排除 {number(data.quality.localHardNoise)} 条；Luna 详析 {number(data.quality.detailedAiOpinions)} 条。详析是处理路径，包含最终的强洞察、弱信号和无参考价值，不能与这些分类数量相加。复用缓存 {number(data.quality.cachedAiOpinions)} 条是已有处理路径中的子集，也不另加到总数。</p>
            </section>
            <section>
              <h3><CircleDollarSign/>AI 本次用量</h3>
              {data.quality.analysisMode === 'rule_demo' ? <dl>
                <div><dt>调用</dt><dd>0 次<strong>本地演示规则</strong></dd></div>
                <div><dt>总 Token</dt><dd>0<strong>没有模型费用</strong></dd></div>
                <div><dt>预估费用</dt><dd>$0.00<strong>美元</strong></dd></div>
              </dl> : usage ? <dl>
                <div><dt>已记录 API 调用</dt><dd>{number(usage.requestCount)} 次<strong>已返回用量的请求；一批可含多条记录</strong></dd></div>
                {usage.stages && <>
                  <div><dt>Decisions 初筛</dt><dd>{number(usage.stages.triage.requestCount)} 次<strong>{cost(usage.stages.triage.estimatedCostUsd)}</strong></dd></div>
                  <div><dt>Luna 详析</dt><dd>{number(usage.stages.detail.requestCount)} 次<strong>{cost(usage.stages.detail.estimatedCostUsd)}</strong></dd></div>
                  <div><dt>调用总数</dt><dd>{number(usage.requestCount)} = {number(usage.stages.triage.requestCount)} + {number(usage.stages.detail.requestCount)}<strong>Decisions 初筛 + Luna 详析</strong></dd></div>
                </>}
                <div><dt>输入 Token</dt><dd>{number(usage.inputTokens)}<strong>其中缓存读取 {number(usage.cachedInputTokens)}；缓存写入 {number(usage.cacheWriteInputTokens ?? 0)}</strong></dd></div>
                <div><dt>输出 Token</dt><dd>{number(usage.outputTokens)}<strong>其中推理 {number(usage.reasoningTokens)}，已包含在输出内</strong></dd></div>
                <div><dt>总 Token</dt><dd>{number(usage.totalTokens)}<strong>{usage.totalTokens === usage.inputTokens + usage.outputTokens ? `${number(usage.inputTokens)} 输入 + ${number(usage.outputTokens)} 输出` : 'API 返回的总用量；可能包含额外计量项'}</strong></dd></div>
                <div className="usage-cost"><dt>预估费用</dt><dd>{cost(usage.estimatedCostUsd)}<strong>实际账单可能略有差异</strong></dd></div>
              </dl> : <p className="legacy-usage">旧版报告没有保存 API usage，无法可靠还原。点击调查页的“重新用 Luna 分析”后即可记录。</p>}
              {usage && <p className="quality-explanation">缓存读取与缓存写入是输入 Token 的子集；推理是输出 Token 的子集，均不再加到总 Token。这里的缓存 Token 是模型用量，与复用已保存分类结果的记录数不同。未返回用量的失败或等待重试请求不计入已记录调用数；费用为初筛与详析合计的美元估算。</p>}
              <p className="quality-explanation">{data.quality.usageExplanation}</p>
              {usage?.pricing?.decisionsSourceUrl && <a className="pricing-link" href={usage.pricing.decisionsSourceUrl} target="_blank" rel="noreferrer">查看 Decisions 初筛单价<ExternalLink/></a>}
              {usage?.pricing && <a className="pricing-link" href={usage.pricing.sourceUrl} target="_blank" rel="noreferrer">查看官方单价（核对于 {usage.pricing.checkedAt}）<ExternalLink/></a>}
            </section>
            <details>
              <summary>查看样本口径与限制</summary>
              <ul>{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
            </details>
          </aside>
        </div>
      </section>
    </main>
  );
};
