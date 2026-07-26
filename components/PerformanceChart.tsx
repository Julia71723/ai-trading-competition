'use client';

import { useEffect, useRef } from 'react';
import type { HistoryPoint } from '@/lib/types';
import {
  Chart,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
  type ChartData,
  type ChartOptions,
} from 'chart.js';

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

const COLORS = {
  chatgpt: '#22c55e',
  claude: '#f97316',
  gemini: '#3b82f6',
  spy: '#a855f7',
};

type ChartMode = 'pct' | 'value';

interface Props {
  series: HistoryPoint[] | null;
  mode: ChartMode;
  onModeChange: (m: ChartMode) => void;
  isLoading: boolean;
}

function toValue(pct: number | null): number | null {
  if (pct === null) return null;
  return 10000 * (1 + pct / 100);
}

export function PerformanceChart({ series, mode, onModeChange, isLoading }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ph = document.getElementById('chart-placeholder');

    if (!series || series.length === 0) {
      if (ph) ph.style.display = 'flex';
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }

    if (ph) ph.style.display = 'none';

    const labels = series.map((p) => {
      const d = new Date(p.date + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    });

    function makeDataset(
      label: string,
      key: keyof Omit<HistoryPoint, 'date'>,
      color: string,
      dashed = false,
    ) {
      const raw = series!.map((p) => p[key]);
      const data = mode === 'pct' ? raw : raw.map(toValue);
      return {
        label,
        data,
        borderColor: color,
        backgroundColor: color + '18',
        tension: 0.3,
        pointRadius: series!.length < 25 ? 4 : 2,
        pointHoverRadius: 6,
        borderWidth: 2,
        fill: false,
        borderDash: dashed ? [6, 4] : [],
        spanGaps: true,
      };
    }

    // Zero reference line
    const zeroLine = {
      label: '',
      data: series.map(() => 0),
      borderColor: 'rgba(255,255,255,0.08)',
      borderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      borderDash: [4, 4],
      spanGaps: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const datasets = [
      makeDataset('ChatGPT', 'chatgpt', COLORS.chatgpt),
      makeDataset('Claude', 'claude', COLORS.claude),
      makeDataset('Gemini', 'gemini', COLORS.gemini),
      makeDataset('S&P 500', 'spy', COLORS.spy, true),
      zeroLine,
    ];

    const yTickCallback = mode === 'pct'
      ? (v: number | string) => (typeof v === 'number' ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : v)
      : (v: number | string) => typeof v === 'number' ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v;

    const tooltipLabel = (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => {
      if (!ctx.dataset.label) return '';
      const y = ctx.parsed.y;
      if (y == null) return '';
      if (mode === 'pct') {
        return ` ${ctx.dataset.label}: ${y >= 0 ? '+' : ''}${y.toFixed(2)}%`;
      }
      return ` ${ctx.dataset.label}: $${y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    const tooltipFooter = (items: Array<{ dataIndex: number }>) => {
      if (mode !== 'pct' || !items[0]) return '';
      const i = items[0].dataIndex;
      const pt = series[i];
      const values = [
        pt.chatgpt != null ? `ChatGPT $${toValue(pt.chatgpt)!.toFixed(2)}` : null,
        pt.claude != null ? `Claude $${toValue(pt.claude)!.toFixed(2)}` : null,
        pt.gemini != null ? `Gemini $${toValue(pt.gemini)!.toFixed(2)}` : null,
      ].filter(Boolean);
      return values.length ? values.join(' · ') : '';
    };

    const chartData: ChartData<'line'> = { labels, datasets };

    const options: ChartOptions<'line'> = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#8b92ae',
            boxWidth: 12,
            padding: 18,
            font: { size: 12 },
            filter: (item) => !!item.text,
          },
        },
        tooltip: {
          backgroundColor: '#0e1120',
          borderColor: '#1c2136',
          borderWidth: 1,
          titleColor: '#edf0f8',
          bodyColor: '#8b92ae',
          padding: 12,
          callbacks: {
            label: tooltipLabel,
            footer: tooltipFooter,
          },
          filter: (item) => !!(item.dataset as { label?: string }).label,
        },
      },
      scales: {
        x: {
          ticks: { color: '#5e6787', maxTicksLimit: 8, maxRotation: 0, font: { size: 11 } },
          grid: { color: '#1c2136' },
          border: { color: '#1c2136' },
        },
        y: {
          ticks: { color: '#5e6787', font: { size: 11 }, callback: yTickCallback },
          grid: { color: '#1c2136' },
          border: { color: '#1c2136' },
        },
      },
    };

    if (chartRef.current) {
      chartRef.current.data = chartData;
      chartRef.current.options = options;
      chartRef.current.update();
    } else {
      chartRef.current = new Chart(canvasRef.current, {
        type: 'line',
        data: chartData,
        options,
      });
    }

    return () => {
      // Don't destroy on mode change — update instead.
    };
  }, [series, mode]);

  useEffect(() => {
    return () => { chartRef.current?.destroy(); };
  }, []);

  const hasData = series && series.length > 0;

  return (
    <div className="card chart-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="section-label">Cumulative return since purchase</span>
        <div className="chart-controls">
          <div className="chart-toggle" role="group" aria-label="Chart mode">
            <button
              className={mode === 'pct' ? 'active' : ''}
              onClick={() => onModeChange('pct')}
            >
              Return %
            </button>
            <button
              className={mode === 'value' ? 'active' : ''}
              onClick={() => onModeChange('value')}
            >
              Portfolio value
            </button>
          </div>
        </div>
      </div>

      <div className="chart-wrapper">
        <div
          className="chart-placeholder"
          id="chart-placeholder"
          style={{ display: isLoading || !hasData ? 'flex' : 'none' }}
        >
          <svg
            width="36" height="36" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ color: 'var(--border-mid)', opacity: 0.6 }}
            aria-hidden="true"
          >
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <p>
            {isLoading
              ? 'Loading chart data…'
              : 'Waiting for the first data points — the chart fills in as the contest runs.'}
          </p>
        </div>
        <canvas ref={canvasRef} id="perf-chart" aria-label="Performance chart" role="img" />
      </div>

      <div className="benchmark-note">
        <div style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--spy)', marginRight: 6 }} />
        S&amp;P 500 benchmark — tracked using SPY &nbsp;|&nbsp; All series normalized to 0% at official purchase date
      </div>
    </div>
  );
}
