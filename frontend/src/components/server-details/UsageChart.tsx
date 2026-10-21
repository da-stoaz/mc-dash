import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Tooltip } from '@heroui/react';
import { buildSparklineArea, buildSparklinePath } from './metricsUtils';

const CHART_H = 48;

type UsageChartProps = {
  label: string;
  values: number[];
  /** Actual sample times or bucket starts, in milliseconds since epoch. */
  timestamps: number[];
  /** Historical bucket peaks, drawn behind the average line. */
  band?: number[];
  /** Historical bucket duration in seconds. */
  resolution?: number;
  stroke: string;
  fill: string;
  avgLabel: string;
  startLabel?: string;
  endLabel?: string;
  emptyLabel?: string;
  maxValue?: number;
  formatValue?: (value: number) => string;
  summary?: string;
};

function percent(value: number) {
  return `${Number(value.toFixed(1))}%`;
}

function sampleTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function UsageChart({
  label, values, timestamps, band, resolution, stroke, fill, avgLabel,
  startLabel, endLabel, emptyLabel = 'Collecting data…',
  maxValue = 100, formatValue = percent, summary,
}: UsageChartProps) {
  // Store the horizontal position so a stationary pointer stays aligned as live
  // samples arrive and the buffer rolls forward.
  const [position, setPosition] = useState<number | null>(null);
  const hasData = values.length > 1 && values.some(Number.isFinite);
  const series = band ?? values;
  const peak = hasData ? Math.max(...series.filter(Number.isFinite)) : null;
  const index = Math.round((position ?? 1) * (values.length - 1));
  const timestamp = timestamps[index];
  const selected = hasData && position !== null && Number.isFinite(timestamp) && Number.isFinite(values[index]);
  const x = hasData ? index / (values.length - 1) * 100 : 0;
  const y = 100 - values[index] / maxValue * 100;
  const time = Number.isFinite(timestamp) ? sampleTime(timestamp) : '';
  const bucketEnd = resolution ? new Date(timestamp + resolution * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : null;
  const description = !hasData ? 'No samples' : `${time}${bucketEnd ? ` – ${bucketEnd}` : ''}, ${band ? 'average ' : ''}${(Number.isFinite(values[index]) ? formatValue(values[index]) : 'Unavailable')}${band ? `, peak ${formatValue(band[index])}` : ''}`;

  function inspect(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0) {
      setPosition(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    let next = index;
    switch (event.key) {
      case 'ArrowLeft': case 'ArrowDown': next--; break;
      case 'ArrowRight': case 'ArrowUp': next++; break;
      case 'Home': next = 0; break;
      case 'End': next = values.length - 1; break;
      case 'Escape': setPosition(null); return;
      default: return;
    }
    event.preventDefault();
    setPosition(Math.min(values.length - 1, Math.max(0, next)) / (values.length - 1));
  }

  return (
    <div className="min-w-0 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="flex h-4 items-center gap-1.5 font-medium">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: stroke }} />
          {label}
        </span>
        <span className="muted whitespace-nowrap text-[11px] leading-4 tabular-nums">
          {summary ?? <>{`Avg ${avgLabel}`}{peak != null && ` · Peak ${formatValue(peak)}`}</>}
        </span>
      </div>
      {hasData ? (
        <div
          role="slider"
          tabIndex={0}
          aria-label={`${label} history. Use arrow keys to inspect samples.`}
          aria-valuemin={0}
          aria-valuemax={values.length - 1}
          aria-valuenow={index}
          aria-valuetext={description}
          className="relative mt-2 h-28 cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          onPointerEnter={inspect}
          onPointerMove={inspect}
          onPointerDown={inspect}
          onPointerLeave={() => setPosition(null)}
          onPointerCancel={() => setPosition(null)}
          onFocus={() => setPosition(1)}
          onBlur={() => setPosition(null)}
          onKeyDown={navigate}
        >
          <svg viewBox={`0 0 100 ${CHART_H}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
            <path d={buildSparklineArea(series, 100, CHART_H, maxValue)} fill={fill} opacity="0.35" />
            <path
              d={buildSparklinePath(values, 100, CHART_H, maxValue)}
              fill="none" stroke={stroke} strokeWidth="1.75"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
            />
          </svg>
          {selected && (
            <>
              <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-dashed border-white/40" style={{ left: `${x}%` }} />
              <Tooltip
                isOpen
                onOpenChange={(open) => { if (!open) setPosition(null); }}
                disableAnimation
                placement="top"
                offset={10}
                updatePositionDeps={[index, timestamp, values[index]]}
                classNames={{ base: 'pointer-events-none', content: 'rounded-md border border-white/15 bg-[#111318] px-2.5 py-2 text-xs text-white shadow-lg tabular-nums' }}
                content={(
                  <div>
                    <div className="text-[10px] text-white/60">
                      <time dateTime={new Date(timestamp).toISOString()}>{time}</time>
                      {bucketEnd && <span className="block">to {bucketEnd}</span>}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span>{band ? 'Average' : label}</span>
                      <span className="font-semibold" style={{ color: stroke }}>{formatValue(values[index])}</span>
                    </div>
                    {band && (
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="text-white/60">Peak</span>
                        <span>{formatValue(band[index])}</span>
                      </div>
                    )}
                  </div>
                )}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                  style={{ left: `${x}%`, top: `${y}%`, backgroundColor: stroke }}
                />
              </Tooltip>
            </>
          )}
        </div>
      ) : (
        <div className="mt-2 flex h-16 items-center justify-center text-xs muted">{emptyLabel}</div>
      )}
      {hasData && (startLabel || endLabel) && (
        <div className="mt-1.5 flex items-center justify-between text-[10px] tabular-nums text-white/35">
          <span>{startLabel}</span><span>{endLabel}</span>
        </div>
      )}
    </div>
  );
}
