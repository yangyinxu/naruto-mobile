import {renderToStaticMarkup} from 'react-dom/server';
import {ReportDossier} from '../components/ReportDossier';
import {ReportData} from '../types';
import reportStyles from '../styles.css?inline';
import offlineStyles from './htmlReport.css?inline';

// This function is embedded in the exported file. Keep it independent of imports,
// React, network requests and application state so file:// works offline.
function initializeHtmlReport() {
  const topics = Array.from(document.querySelectorAll<HTMLElement>('[data-report-topic]'));
  const links = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-report-topic-link]'));

  const selectSentiment = (topic: HTMLElement, sentiment: string) => {
    topic.querySelectorAll<HTMLElement>('[data-evidence-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.evidencePanel !== sentiment;
    });
    topic.querySelectorAll<HTMLButtonElement>('[data-report-sentiment]').forEach((button) => {
      const selected = button.dataset.reportSentiment === sentiment;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
  };

  const selectTopic = (index: string) => {
    topics.forEach((topic) => { topic.hidden = topic.dataset.reportTopic !== index; });
    links.forEach((link) => {
      const selected = link.dataset.reportTopicLink === index;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  };

  topics.forEach((topic) => {
    const buttons = Array.from(topic.querySelectorAll<HTMLButtonElement>('[data-report-sentiment]'));
    const hasEvidence = (button: HTMLButtonElement) => {
      const panel = topic.querySelector(`[data-evidence-panel="${button.dataset.reportSentiment}"]`);
      return Boolean(panel?.querySelector('.evidence-item'));
    };
    const initial = buttons.find((button) => button.dataset.reportSentiment === 'negative' && hasEvidence(button))
      ?? buttons.find(hasEvidence) ?? buttons[0];
    if (initial) selectSentiment(topic, initial.dataset.reportSentiment!);
    buttons.forEach((button) => {
      button.addEventListener('click', () => selectSentiment(topic, button.dataset.reportSentiment!));
    });
    const tablist = topic.querySelector<HTMLElement>('[role="tablist"]');
    tablist?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
  });

  links.forEach((link) => link.addEventListener('click', () => {
    selectTopic(link.dataset.reportTopicLink!);
    // On narrow screens the detail sits below the topic navigation.
    if (window.matchMedia('(max-width: 760px)').matches) {
      topics.find((topic) => !topic.hidden)?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }));
  if (topics[0]) selectTopic(topics[0].dataset.reportTopic!);
  document.querySelector('[data-print-report]')?.addEventListener('click', () => window.print());
  document.documentElement.classList.add('html-report-interactive');
}

export const buildHtmlReport = (title: string, data: ReportData): string => {
  const script = `(${initializeHtmlReport.toString()})();`;
  return '<!doctype html>\n' + renderToStaticMarkup(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="referrer" content="no-referrer"/>
        <title>{`${title} · 调查报告`}</title>
        <style dangerouslySetInnerHTML={{__html: reportStyles + '\n' + offlineStyles}}/>
      </head>
      <body className="html-report">
        <main className="report-page">
          <div className="report-toolbar content-width">
            <div className="html-report-note">
              <strong>离线调查报告</strong>
              <span>全部主题与证据已保存 · 无需安装程序</span>
              <small>报告生成时间：{data.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}</small>
            </div>
            <button className="secondary-action html-print-button" data-print-report="">打印 / 保存 PDF</button>
          </div>
          <noscript><p className="html-report-noscript content-width">浏览器已禁用 JavaScript，以下按顺序展示全部主题与各类意见。</p></noscript>
          <ReportDossier title={title} data={data} exportAll/>
        </main>
        <script dangerouslySetInnerHTML={{__html: script}}/>
      </body>
    </html>
  );
};
