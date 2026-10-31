import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Tooltip } from '@heroui/react';
import { buildSparklineArea, buildSparklinePath, LIVE_GAP_MS } from './metricsUtils';

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
  absoluteValues?: (number | null | undefined)[];
  absolutePeaks?: (number | null | undefined)[];
  formatAbsolute?: (value: number) => string;
  absoluteCapacity?: number | null;
  window?: [number, number];
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
  maxValue = 100, formatValue = percent, summary, absoluteValues, absolutePeaks, formatAbsolute, absoluteCapacity, window,
}: UsageChartProps) {
  // Store the horizontal position so a stationary pointer stays aligned as live
  // samples arrive and the buffer rolls forward.
  const [position, setPosition] = useState<number | null>(null);
  const series = band ?? values;
  const start = window?.[0] ?? timestamps[0];
  const end = window?.[1] ?? timestamps.at(-1) ?? start;
  // Let the preceding sample sit outside the SVG and clip the connecting line.
  // Clamping its x coordinate would move an older reading to the 60s boundary.
  const positions = timestamps.map(t => end > start ? (t - start) / (end - start) : 1);
  const visibleIndices = positions.flatMap((x, i) => x >= 0 && x <= 1 ? [i] : []);
  const hasData = visibleIndices.some(i => Number.isFinite(values[i]));
  const peaks = visibleIndices.map(i => series[i]).filter(Number.isFinite);
  const peak = peaks.length ? Math.max(...peaks) : null;
  const gapBefore = timestamps.map((t, i) => i > 0 && t - timestamps[i - 1] > (resolution ? resolution * 1500 : window ? LIVE_GAP_MS : Infinity));
  const firstIndex = visibleIndices[0] ?? 0;
  const lastIndex = visibleIndices.at(-1) ?? 0;
  const index = visibleIndices.reduce((best, i) => Math.abs(positions[i] - (position ?? 1)) < Math.abs(positions[best] - (position ?? 1)) ? i : best, firstIndex);
  const timestamp = timestamps[index];
  const selected = hasData && position !== null && Number.isFinite(timestamp) && Number.isFinite(values[index]);
  const x = hasData ? positions[index] * 100 : 0;
  const y = 100 - values[index] / maxValue * 100;
  const time = Number.isFinite(timestamp) ? sampleTime(timestamp) : '';
  const bucketEnd = resolution ? new Date(timestamp + resolution * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }) : null;
  const absolute = (value: number | null | undefined) => value != null && Number.isFinite(value) && formatAbsolute ? ` · ${formatAbsolute(value)}` : '';
  const absoluteSample = absolute(absoluteValues?.[index]).replace(/^ · /, '');
  const absolutePeak = absolute(absolutePeaks?.[index]).replace(/^ · /, '');
  const sampleLabel = Number.isFinite(values[index]) ? `${formatValue(values[index])}${absolute(absoluteValues?.[index])}` : 'Unavailable';
  const peakLabel = band && Number.isFinite(band[index]) ? `${formatValue(band[index])}${absolute(absolutePeaks?.[index])}` : '';
  const description = !hasData ? 'No samples' : `${time}${bucketEnd ? ` – ${bucketEnd}` : ''}, ${band ? 'average ' : ''}${(Number.isFinite(values[index]) ? sampleLabel : 'Unavailable')}${band ? `, peak ${peakLabel}` : ''}`;

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
      case 'Home': next = firstIndex; break;
      case 'End': next = lastIndex; break;
      case 'Escape': setPosition(null); return;
      default: return;
    }
    event.preventDefault();
    setPosition(positions[Math.min(lastIndex, Math.max(firstIndex, next))]);
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
        <div className={formatAbsolute ? 'mt-4 grid grid-cols-[max-content_minmax(0,1fr)_max-content] gap-x-2' : 'mt-2'}>
        {formatAbsolute && (
          <div aria-label={`${label} absolute axis`} title={absoluteCapacity == null ? 'The allocation changed or is unavailable; absolute readings remain in the tooltip.' : undefined} className="flex h-28 flex-col justify-between text-right text-[10px] leading-none tabular-nums text-white/50">
            {[1, 0.5, 0].map(fraction => <span key={fraction}>{absoluteCapacity != null ? formatAbsolute(absoluteCapacity * fraction) : '—'}</span>)}
          </div>
        )}
        <div
          role="slider"
          tabIndex={0}
          aria-label={`${label} history. Use arrow keys to inspect samples.`}
          aria-valuemin={firstIndex}
          aria-valuemax={lastIndex}
          aria-valuenow={index}
          aria-valuetext={description}
          className="relative h-28 cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          onPointerEnter={inspect}
          onPointerMove={inspect}
          onPointerDown={inspect}
          onPointerLeave={() => setPosition(null)}
          onPointerCancel={() => setPosition(null)}
          onFocus={() => setPosition(1)}
          onBlur={() => setPosition(null)}
          onKeyDown={navigate}
        >
          <svg viewBox={`0 0 100 ${CHART_H}`} className="h-full w-full overflow-hidden" preserveAspectRatio="none" aria-hidden="true">
            {formatAbsolute && [0, CHART_H / 2, CHART_H].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="rgba(255,255,255,0.12)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
            <path d={buildSparklineArea(series, 100, CHART_H, maxValue, positions, gapBefore)} fill={fill} opacity="0.35" />
            <path
              d={buildSparklinePath(values, 100, CHART_H, maxValue, positions, gapBefore)}
              fill="none" stroke={stroke} strokeWidth="1.75"
              strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
            />
            {values.map((value, i) => Number.isFinite(value) &&
              (i === 0 || !Number.isFinite(values[i - 1]) || gapBefore[i]) &&
              (i === values.length - 1 || !Number.isFinite(values[i + 1]) || gapBefore[i + 1]) && (
                <circle key={timestamps[i]} cx={positions[i] * 100} cy={CHART_H * (1 - value / maxValue)} r="0.7" fill={stroke} />
              ))}
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
                      <span>{band ? 'Average %' : formatAbsolute ? label.replace('usage', '%') : label}</span>
                      <span className="font-semibold" style={{ color: stroke }}>{formatValue(values[index])}</span>
                    </div>
                    {absoluteSample && (
                      <div className="mt-0.5 flex items-center justify-between gap-3">
                        <span>{band ? 'Average usage' : label}</span>
                        <span className="font-semibold" style={{ color: stroke }}>{absoluteSample}</span>
                      </div>
                    )}
                    {band && (
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="text-white/60">Peak %</span>
                        <span>{formatValue(band[index])}</span>
                      </div>
                    )}
                    {band && absolutePeak && (
                      <div className="mt-0.5 flex items-center justify-between gap-3">
                        <span className="text-white/60">Peak usage</span>
                        <span>{absolutePeak}</span>
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
        {formatAbsolute && <div aria-label={`${label} percentage axis`} className="flex h-28 flex-col justify-between text-[10px] leading-none tabular-nums text-white/50">
          {[100, 50, 0].map(value => <span key={value}>{value}%</span>)}
        </div>}
        {(startLabel || endLabel) && <div className={`${formatAbsolute ? 'col-start-2' : ''} mt-1.5 flex justify-between text-[10px] tabular-nums text-white/35`}><span>{startLabel}</span><span>{endLabel}</span></div>}
        </div>
      ) : (
        <div className="mt-2 flex h-16 items-center justify-center text-xs muted">{emptyLabel}</div>
      )}

    </div>
  );
}
