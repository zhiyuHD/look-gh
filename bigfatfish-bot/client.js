/**
 * BigFatFish Bot — Client half.
 *
 * Registers the usage page (`main`, key `bigfatfish-usage`) and its sidebar
 * entry, then polls the Host route `/bigfatfish/usage` every 5 seconds.
 *
 * Browser-module format: this file is a plain browser module registered through
 * `window.__ModuleLoader__.load`; it must never import a DSH package. React
 * comes from the host module table via `require('react')`.
 */
window.__ModuleLoader__.load({
  id: 'bigfatfish-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace shared by the page and the sidebar entry. */
    const NS = 'bigfatfish-bot';
    /** Poll interval required by CONTRACT.md §8. */
    const REFRESH_MS = 5000;

    /**
     * Page copy. Mirrors `locale/zh.json` and `locale/en.json`; the two `meta.*`
     * entries are flat here only so that one set of strings stays the source of
     * truth for both the package metadata (which the Host reads from the JSON
     * files) and the rendered page.
     */
    const zh = {
      'meta.title': 'BigFatFish Bot',
      'meta.description':
        'GitHub issue 机器人：Owner 批准后自动改代码、跑测试并开 PR；用量页展示每个白名单仓库今日的处理记录。',
      nav: 'BigFatFish',
      modelTitle: '会话模型',
      modelHint: 'Bot 的 triage / 实现 / review 会话使用这里的 Provider 与模型；留空用部署默认。',
      modelProvider: 'Provider',
      modelName: '模型',
      save: '保存',
      modelReset: '恢复默认',
      modelSaved: '模型配置已保存（对下一次会话生效）。',
      modelSaveFailed: '模型配置保存失败。',
      modelCurrent: '当前：{provider} / {model}',
      whitelistTitle: '白名单仓库',
      whitelistHint: '只处理这些仓库；修改立即生效。',
      whitelistEmpty: '还没有白名单仓库。',
      repoPlaceholder: 'owner/repo',
      add: '添加',
      remove: '移除',
      resetRepo: '重置今日次数',
      resetDone: '已重置该仓库今日次数。',
      resetFailed: '重置失败。',
      whitelistSaved: '白名单已保存。',
      whitelistSaveFailed: '白名单保存失败。',
      title: 'BigFatFish 用量',
      subtitle: '查看每个白名单仓库今日的 issue 与 review 处理情况。',
      refresh: '刷新',
      refreshing: '刷新中…',
      updatedAt: '更新于 {time}',
      neverUpdated: '尚未更新',
      loading: '加载中…',
      errorTitle: '无法读取用量数据',
      errorHttp: '服务返回 HTTP {status}。',
      errorNetwork: '网络请求失败。',
      errorInvalid: '响应不是有效的 JSON。',
      retry: '重试',
      emptyTitle: '今天还没有处理记录',
      emptyHint: '在 issue 里回复 /approve 后，处理过程会显示在这里。',
      repositories: '仓库',
      date: '日期',
      sessions: '会话',
      issues: 'Issue',
      reviews: 'Review',
      tokens: 'Tokens',
      repoQuota: '{count}/{limit}',
      repoEmpty: '今天这个仓库还没有处理记录。',
      issueRef: '#{number}',
      reviewRef: 'PR #{number}',
      untitled: '（无标题）',
      prLink: 'PR',
      commitRef: 'commit {sha}',
      tokenValue: '{value} tokens',
      statusRunning: '进行中',
      statusQueued: '排队中',
      statusDone: '已完成',
      statusFailed: '失败',
      statusPending: '等待中',
      statusUnknown: '未知',
      unknown: '未知',
      footnote: '每 {seconds} 秒自动刷新 · 时区 {zone}',
    };

    const en = {
      'meta.title': 'BigFatFish Bot',
      'meta.description':
        "GitHub issue bot: after an owner approves, it edits code, runs tests and opens a PR; the usage page lists today's runs per repository.",
      nav: 'BigFatFish',
      modelTitle: 'Session model',
      modelHint: 'Triage / implementation / review sessions use this provider and model. Empty falls back to the deployment default.',
      modelProvider: 'Provider',
      modelName: 'Model',
      save: 'Save',
      modelReset: 'Use default',
      modelSaved: 'Model saved (applies to the next session).',
      modelSaveFailed: 'Could not save the model selection.',
      modelCurrent: 'Current: {provider} / {model}',
      whitelistTitle: 'Allow-listed repositories',
      whitelistHint: 'Only these repositories are handled; changes apply immediately.',
      whitelistEmpty: 'No repositories allow-listed yet.',
      repoPlaceholder: 'owner/repo',
      add: 'Add',
      remove: 'Remove',
      resetRepo: 'Reset today',
      resetDone: "Today's counter was reset.",
      resetFailed: 'Reset failed.',
      whitelistSaved: 'Whitelist saved.',
      whitelistSaveFailed: 'Could not save the whitelist.',
      title: 'BigFatFish usage',
      subtitle: "Today's issue and review work for each allow-listed repository.",
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updatedAt: 'Updated {time}',
      neverUpdated: 'Not updated yet',
      loading: 'Loading…',
      errorTitle: 'Could not load usage data',
      errorHttp: 'The server returned HTTP {status}.',
      errorNetwork: 'The network request failed.',
      errorInvalid: 'The response was not valid JSON.',
      retry: 'Retry',
      emptyTitle: 'No work yet today',
      emptyHint: 'Reply /approve in an issue and its run will show up here.',
      repositories: 'Repositories',
      date: 'Date',
      sessions: 'Sessions',
      issues: 'Issues',
      reviews: 'Reviews',
      tokens: 'Tokens',
      repoQuota: '{count}/{limit}',
      repoEmpty: 'No runs for this repository yet today.',
      issueRef: '#{number}',
      reviewRef: 'PR #{number}',
      untitled: '(untitled)',
      prLink: 'PR',
      commitRef: 'commit {sha}',
      tokenValue: '{value} tokens',
      statusRunning: 'Running',
      statusQueued: 'Queued',
      statusDone: 'Done',
      statusFailed: 'Failed',
      statusPending: 'Pending',
      statusUnknown: 'Unknown',
      unknown: 'Unknown',
      footnote: 'Refreshes every {seconds} seconds · time zone {zone}',
    };

    /**
     * Resolve a Host API path against the directory the UI is served from.
     * Copied from dshmarket so the plugin keeps working behind a reverse proxy
     * that mounts DSH under a path prefix.
     */
    function api(path) {
      const relative = path.replace(/^\/+/, '');
      if (typeof document === 'undefined') return `/${relative}`;
      return new URL(relative, document.baseURI).pathname;
    }

    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    function tokensOf(tokens) {
      return tokens && typeof tokens === 'object' ? asNumber(tokens.total) : 0;
    }

    function numberFormat(value) {
      const number = asNumber(value);
      try {
        return new Intl.NumberFormat().format(number);
      } catch {
        return String(number);
      }
    }

    function clockFormat(ms) {
      const date = new Date(ms);
      if (!Number.isFinite(date.getTime())) return '';
      try {
        return new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(date);
      } catch {
        return date.toISOString().slice(11, 19);
      }
    }

    function statusColor(status) {
      switch (status) {
        case 'done':
          return 'var(--dsw-alias-state-success-primary)';
        case 'failed':
          return 'var(--dsw-alias-state-error-primary)';
        case 'running':
          return 'var(--dsw-alias-state-business-primary)';
        case 'queued':
          return 'var(--dsw-alias-state-warn-primary)';
        default:
          return 'var(--dsw-alias-label-secondary)';
      }
    }

    function statusLabel(t, status) {
      switch (status) {
        case 'running':
          return t('statusRunning');
        case 'queued':
          return t('statusQueued');
        case 'done':
          return t('statusDone');
        case 'failed':
          return t('statusFailed');
        case 'pending':
          return t('statusPending');
        default:
          return t('statusUnknown');
      }
    }

    function errorText(t, error) {
      if (!error) return '';
      if (error.kind === 'http') return t('errorHttp', { status: String(error.status) });
      if (error.kind === 'invalid') return t('errorInvalid');
      return t('errorNetwork');
    }

    /** Inline fish artwork for the sidebar entry; monochrome, follows the row color. */
    const FISH_BODY =
      'M6 32 C12 20 24 16 33 16 C39 16 44 23 44 32 C44 41 39 48 33 48 C24 48 12 44 6 32 Z ' +
      'M20 28 m-3.2 0 a3.2 3.2 0 1 0 6.4 0 a3.2 3.2 0 1 0 -6.4 0 Z';
    const FISH_TAIL = 'M44 32 L57 21 L61 25 L56 32 L61 39 L57 43 Z';
    const FISH_FIN = 'M25 18 L29 10 L36 16 Z';

    function FishIcon(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16;
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { key: 'tail', d: FISH_TAIL }),
        h('path', { key: 'fin', d: FISH_FIN }),
        h('path', { key: 'body', d: FISH_BODY, fillRule: 'evenodd' }),
      );
    }

    const CSS = `
.bff-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px 40px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 1.5;
}
.bff-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.bff-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.bff-subtitle {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.bff-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bff-updated {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.bff-button {
  appearance: none;
  cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  line-height: 1.2;
  font-family: inherit;
}
.bff-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.bff-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.bff-button:disabled {
  cursor: default;
  opacity: 0.6;
}
.bff-banner {
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  padding: 10px 14px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bff-banner-title {
  font-weight: 600;
}
.bff-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.bff-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
.bff-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 12px 14px;
}
.bff-stat-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.bff-stat-value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}
.bff-section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.bff-repos {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bff-repo {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 14px 16px;
}
.bff-repo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.bff-repo-name {
  font-weight: 600;
  font-size: 14px;
  word-break: break-all;
}
.bff-repo-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.bff-quota {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}
.bff-quota[data-full='true'] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.bff-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bff-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.bff-row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 160px;
  flex: 1 1 200px;
}
.bff-ref {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bff-row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.bff-status {
  font-size: 11px;
  line-height: 18px;
  padding: 0 7px;
  border: 1px solid currentColor;
  border-radius: 999px;
  white-space: nowrap;
}
.bff-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: none;
  white-space: nowrap;
}
.bff-link:hover {
  text-decoration: underline;
}
.bff-link:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
  border-radius: 4px;
}
.bff-tokens {
  margin-left: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bff-subtle {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.bff-empty {
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 28px 20px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.bff-empty-title {
  margin: 0 0 4px;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.bff-empty-hint {
  margin: 0;
  font-size: 12px;
}
.bff-loading {
  padding: 40px 0;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.bff-footnote {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.bff-whitelist {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.bff-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
}
.bff-chip-remove {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.bff-chip-remove:hover { color: var(--dsw-alias-state-error-primary); }
.bff-model-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.bff-whitelist-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.bff-input {
  min-width: 220px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
.bff-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.bff-small { padding: 5px 10px; font-size: 12px; }
.bff-notice {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.bff-notice[data-kind="error"] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
@media (max-width: 640px) {
  .bff-page { padding: 16px 14px 32px; }
  .bff-tokens { margin-left: 0; }
}
`;

    function Stat(props) {
      return h(
        'div',
        { className: 'bff-stat' },
        h('span', { className: 'bff-stat-label' }, props.label),
        h('span', { className: 'bff-stat-value' }, props.value),
      );
    }

    function IssueRow(props) {
      const t = props.t;
      const issue = props.issue && typeof props.issue === 'object' ? props.issue : {};
      const title =
        typeof issue.title === 'string' && issue.title.trim() !== '' ? issue.title : t('untitled');
      const errorDetail = typeof issue.error === 'string' && issue.error !== '' ? issue.error : undefined;
      return h(
        'div',
        { className: 'bff-row' },
        h(
          'div',
          { className: 'bff-row-main' },
          h('span', { className: 'bff-ref' }, t('issueRef', { number: numberFormat(issue.number) })),
          h('span', { className: 'bff-row-title', title }, title),
        ),
        h(
          'span',
          {
            className: 'bff-status',
            style: { color: statusColor(issue.status) },
            title: errorDetail,
          },
          statusLabel(t, issue.status),
        ),
        typeof issue.prUrl === 'string' && issue.prUrl !== ''
          ? h(
              'a',
              {
                className: 'bff-link',
                href: issue.prUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              t('prLink'),
            )
          : null,
        ...(Array.isArray(issue.extraPrs) ? issue.extraPrs : []).map((extra, index) =>
          extra && typeof extra.url === 'string' && extra.url !== ''
            ? h(
                'a',
                {
                  key: `extra-pr-${index}`,
                  className: 'bff-link',
                  href: extra.url,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                `PR (${typeof extra.repo === 'string' ? extra.repo : index + 1})`,
              )
            : null,
        ),
        h(
          'span',
          { className: 'bff-tokens' },
          t('tokenValue', { value: numberFormat(tokensOf(issue.tokens)) }),
        ),
      );
    }

    function ReviewRow(props) {
      const t = props.t;
      const review = props.review && typeof props.review === 'object' ? props.review : {};
      const sha = typeof review.commitSha === 'string' ? review.commitSha.slice(0, 7) : '';
      return h(
        'div',
        { className: 'bff-row' },
        h(
          'div',
          { className: 'bff-row-main' },
          h(
            'span',
            { className: 'bff-ref' },
            t('reviewRef', { number: numberFormat(review.pullNumber) }),
          ),
          sha !== '' ? h('span', { className: 'bff-subtle' }, t('commitRef', { sha })) : null,
        ),
        h(
          'span',
          { className: 'bff-status', style: { color: statusColor(review.status) } },
          statusLabel(t, review.status),
        ),
        h(
          'span',
          { className: 'bff-tokens' },
          t('tokenValue', { value: numberFormat(tokensOf(review.tokens)) }),
        ),
      );
    }

    function RepoCard(props) {
      const t = props.t;
      const repo = props.repo && typeof props.repo === 'object' ? props.repo : {};
      const issues = Array.isArray(repo.issues) ? repo.issues : [];
      const reviews = Array.isArray(repo.reviews) ? repo.reviews : [];
      const count = asNumber(repo.count);
      const limit = asNumber(repo.limit) > 0 ? asNumber(repo.limit) : 5;
      const full = count >= limit;
      const name = typeof repo.repo === 'string' && repo.repo !== '' ? repo.repo : t('unknown');
      return h(
        'article',
        { className: 'bff-repo' },
        h(
          'div',
          { className: 'bff-repo-head' },
          h('div', { className: 'bff-repo-name' }, name),
          h(
            'div',
            { className: 'bff-repo-meta' },
            h(
              'span',
              { className: 'bff-quota', 'data-full': full ? 'true' : undefined },
              t('repoQuota', { count: numberFormat(count), limit: numberFormat(limit) }),
            ),
            h(
              'span',
              null,
              t('tokenValue', { value: numberFormat(tokensOf(repo.tokens)) }),
            ),
            props.onReset
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'bff-button bff-small',
                    onClick: () => props.onReset(name),
                  },
                  t('resetRepo'),
                )
              : null,
          ),
        ),
        issues.length > 0
          ? h(
              'div',
              { className: 'bff-list' },
              issues.map((issue, index) =>
                h(IssueRow, {
                  key: `issue-${index}-${issue && issue.number !== undefined ? issue.number : index}`,
                  t,
                  issue,
                }),
              ),
            )
          : null,
        reviews.length > 0
          ? h(
              'div',
              { className: 'bff-list' },
              reviews.map((review, index) =>
                h(ReviewRow, {
                  key: `review-${index}-${
                    review && review.reviewId !== undefined ? review.reviewId : index
                  }`,
                  t,
                  review,
                }),
              ),
            )
          : null,
        issues.length === 0 && reviews.length === 0
          ? h('div', { className: 'bff-subtle' }, t('repoEmpty'))
          : null,
      );
    }

    function UsagePage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [refreshing, setRefreshing] = React.useState(false);
      const [tick, setTick] = React.useState(0);
      const [notice, setNotice] = React.useState(null);
      const [draftRepo, setDraftRepo] = React.useState('');
      const [modelConfig, setModelConfig] = React.useState(null);
      const [modelProvider, setModelProvider] = React.useState('');
      const [modelName, setModelName] = React.useState('');

      React.useEffect(() => {
        const controller = new AbortController();
        let disposed = false;
        let timer = null;

        const request = async (manual) => {
          if (manual && !disposed) setRefreshing(true);
          try {
            const response = await fetch(api('/bigfatfish/usage'), {
              cache: 'no-store',
              headers: { accept: 'application/json' },
              signal: controller.signal,
            });
            if (disposed) return;
            if (!response.ok) {
              setError({ kind: 'http', status: response.status });
              return;
            }
            let body;
            try {
              body = await response.json();
            } catch {
              if (!disposed) setError({ kind: 'invalid' });
              return;
            }
            if (disposed) return;
            setData(body && typeof body === 'object' ? body : {});
            setError(null);
          } catch (caught) {
            if (disposed || controller.signal.aborted) return;
            setError({
              kind: 'network',
              detail:
                caught && typeof caught.message === 'string' && caught.message !== ''
                  ? caught.message
                  : '',
            });
          } finally {
            if (!disposed) {
              setLoading(false);
              if (manual) setRefreshing(false);
            }
          }
        };

        request(tick > 0);
        timer = setInterval(() => {
          request(false);
        }, REFRESH_MS);

        return () => {
          disposed = true;
          controller.abort();
          if (timer !== null) clearInterval(timer);
        };
      }, [tick]);

      React.useEffect(() => {
        let disposed = false;
        fetch(api('/bigfatfish/model'), { cache: 'no-store', headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => {
            if (disposed || !body) return;
            setModelConfig(body);
            setModelProvider(typeof body.provider === 'string' ? body.provider : '');
            setModelName(typeof body.model === 'string' ? body.model : '');
          })
          .catch(() => {});
        return () => {
          disposed = true;
        };
      }, []);

      const saveModel = async (payload) => {
        try {
          const response = await fetch(api('/bigfatfish/model'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const body = await response.json();
          setModelConfig((previous) => ({ ...(previous || {}), ...body }));
          setModelProvider(typeof body.provider === 'string' ? body.provider : modelProvider);
          setModelName(typeof body.model === 'string' ? body.model : modelName);
          setNotice({ kind: 'ok', text: t('modelSaved') });
        } catch {
          setNotice({ kind: 'error', text: t('modelSaveFailed') });
        }
      };

      const refresh = () => {
        setRefreshing(true);
        setTick((value) => value + 1);
      };

      const postJson = async (path, body) => {
        const response = await fetch(api(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      };

      const saveRepos = async (repos) => {
        try {
          await postJson('/bigfatfish/repos', { repos });
          setNotice({ kind: 'ok', text: t('whitelistSaved') });
          setTick((value) => value + 1);
        } catch {
          setNotice({ kind: 'error', text: t('whitelistSaveFailed') });
        }
      };

      const addRepo = () => {
        const repo = draftRepo.trim();
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
          setNotice({ kind: 'error', text: t('whitelistSaveFailed') });
          return;
        }
        const current = data && Array.isArray(data.allowedRepos) ? data.allowedRepos : [];
        if (current.includes(repo)) {
          setDraftRepo('');
          return;
        }
        setDraftRepo('');
        void saveRepos([...current, repo]);
      };

      const resetRepo = async (repo) => {
        try {
          await postJson('/bigfatfish/usage/reset', { repo });
          setNotice({ kind: 'ok', text: t('resetDone') });
          setTick((value) => value + 1);
        } catch {
          setNotice({ kind: 'error', text: t('resetFailed') });
        }
      };

      const totals = data && data.totals && typeof data.totals === 'object' ? data.totals : {};
      const repos = data && Array.isArray(data.repos) ? data.repos : [];
      const allowedRepos = data && Array.isArray(data.allowedRepos) ? data.allowedRepos : [];
      const date = data && typeof data.date === 'string' && data.date !== '' ? data.date : t('unknown');
      const sessionCount = asNumber(totals.issues) + asNumber(totals.reviews);
      const updatedAt = data ? asNumber(data.updatedAt) : 0;

      const stats = h(
        'section',
        { className: 'bff-stats', key: 'stats' },
        h(Stat, { key: 'date', label: t('date'), value: date }),
        h(Stat, { key: 'sessions', label: t('sessions'), value: numberFormat(sessionCount) }),
        h(Stat, { key: 'issues', label: t('issues'), value: numberFormat(asNumber(totals.issues)) }),
        h(Stat, {
          key: 'reviews',
          label: t('reviews'),
          value: numberFormat(asNumber(totals.reviews)),
        }),
        h(Stat, {
          key: 'tokens',
          label: t('tokens'),
          value: numberFormat(tokensOf(totals.tokens)),
        }),
      );

      const modelProviders = modelConfig && Array.isArray(modelConfig.providers) ? modelConfig.providers : [];
      const selectedProvider = modelProviders.find((provider) => provider && provider.id === modelProvider);
      const modelOptions = selectedProvider && Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
      const modelSection = h(
        'section',
        { key: 'model' },
        h('h2', { className: 'bff-section-title' }, t('modelTitle')),
        h('p', { className: 'bff-subtle' }, t('modelHint')),
        h(
          'div',
          { className: 'bff-model-row' },
          h(
            'select',
            {
              className: 'bff-input',
              value: modelProvider,
              onChange: (event) => setModelProvider(event.target.value),
            },
            modelProviders.map((provider) =>
              h('option', { key: provider.id, value: provider.id }, provider.name || provider.id),
            ),
          ),
          h('input', {
            className: 'bff-input',
            list: 'bff-model-options',
            value: modelName,
            placeholder: t('modelName'),
            onChange: (event) => setModelName(event.target.value),
          }),
          h(
            'datalist',
            { id: 'bff-model-options' },
            modelOptions.map((model) => h('option', { key: model, value: model })),
          ),
          h(
            'button',
            { type: 'button', className: 'bff-button bff-small', onClick: () => void saveModel({ provider: modelProvider, model: modelName }) },
            t('save'),
          ),
          h(
            'button',
            { type: 'button', className: 'bff-button bff-small', onClick: () => void saveModel({ reset: true }) },
            t('modelReset'),
          ),
        ),
        modelConfig
          ? h(
              'p',
              { className: 'bff-subtle' },
              t('modelCurrent', {
                provider: String(modelConfig.provider ?? ''),
                model: String(modelConfig.model ?? ''),
              }),
            )
          : null,
      );

      const whitelistSection = h(
        'section',
        { key: 'whitelist' },
        h('h2', { className: 'bff-section-title' }, t('whitelistTitle')),
        h('p', { className: 'bff-subtle' }, t('whitelistHint')),
        h(
          'div',
          { className: 'bff-whitelist' },
          allowedRepos.length === 0
            ? h('span', { className: 'bff-subtle' }, t('whitelistEmpty'))
            : allowedRepos.map((repo) =>
                h(
                  'span',
                  { className: 'bff-chip', key: repo },
                  repo,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'bff-chip-remove',
                      title: t('remove'),
                      onClick: () => void saveRepos(allowedRepos.filter((item) => item !== repo)),
                    },
                    '×',
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'bff-whitelist-add' },
          h('input', {
            className: 'bff-input',
            value: draftRepo,
            placeholder: t('repoPlaceholder'),
            onChange: (event) => setDraftRepo(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addRepo();
              }
            },
          }),
          h('button', { type: 'button', className: 'bff-button bff-small', onClick: addRepo }, t('add')),
        ),
      );

      const repoSection = h(
        'section',
        { key: 'repos' },
        h('h2', { className: 'bff-section-title' }, t('repositories')),
        repos.length === 0
          ? h(
              'div',
              { className: 'bff-empty' },
              h('p', { className: 'bff-empty-title' }, t('emptyTitle')),
              h('p', { className: 'bff-empty-hint' }, t('emptyHint')),
            )
          : h(
              'div',
              { className: 'bff-repos' },
              repos.map((repo, index) =>
                h(RepoCard, {
                  key: `repo-${index}-${repo && typeof repo.repo === 'string' ? repo.repo : ''}`,
                  t,
                  repo,
                  onReset: (repoName) => void resetRepo(repoName),
                }),
              ),
            ),
      );

      const footnote =
        data && typeof data.timeZone === 'string' && data.timeZone !== ''
          ? h(
              'p',
              { className: 'bff-footnote', key: 'footnote' },
              t('footnote', { seconds: String(REFRESH_MS / 1000), zone: data.timeZone }),
            )
          : null;

      let body = null;
      if (!data) {
        if (loading) body = h('div', { className: 'bff-loading', key: 'loading' }, t('loading'));
      } else {
        body = h(
          'div',
          { className: 'bff-body', key: 'body' },
          stats,
          modelSection,
          whitelistSection,
          repoSection,
          footnote,
        );
      }

      return h(
        'div',
        { className: 'bff-page' },
        h('style', { key: 'bigfatfish-style' }, CSS),
        h(
          'header',
          { className: 'bff-header', key: 'header' },
          h(
            'div',
            null,
            h('h1', { className: 'bff-title' }, t('title')),
            h('p', { className: 'bff-subtitle' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'bff-actions' },
            h(
              'span',
              { className: 'bff-updated' },
              updatedAt > 0 ? t('updatedAt', { time: clockFormat(updatedAt) }) : t('neverUpdated'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'bff-button',
                onClick: refresh,
                disabled: refreshing,
              },
              refreshing ? t('refreshing') : t('refresh'),
            ),
          ),
        ),
        notice
          ? h(
              'div',
              { className: 'bff-notice', 'data-kind': notice.kind, role: 'status', key: 'notice' },
              notice.text,
            )
          : null,
        error
          ? h(
              'div',
              { className: 'bff-banner', role: 'alert', key: 'error' },
              h('div', { className: 'bff-banner-title' }, t('errorTitle')),
              h('div', null, errorText(t, error)),
              error.detail ? h('div', { className: 'bff-subtle' }, error.detail) : null,
            )
          : null,
        body,
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'bigfatfish-bot: locale');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'bigfatfish-usage',
              locale: NS,
              inject: () => ({ t }),
            },
            UsagePage,
          ),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'bigfatfish-usage',
              order: 20,
              label: () => t('nav'),
              locale: NS,
            },
            FishIcon,
          ),
        );
      },
    };
  },
});
