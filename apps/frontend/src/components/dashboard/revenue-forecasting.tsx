'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  projectRevenue,
  calculateChurnMetrics,
  generateRenewalCalendar,
  formatCurrency,
  formatPercentage,
  type Subscription,
  type ForecastScenario,
  type RevenueForecast,
  type ChurnMetrics,
} from '@/lib/revenue-forecasting';

interface RevenueForecastingProps {
  subscriptions: Subscription[];
  historicalChurn: {
    churned_30d: number;
    churned_60d: number;
    churned_90d: number;
  };
}

export function RevenueForecastingView({ subscriptions, historicalChurn }: RevenueForecastingProps) {
  const [forecastDays, setForecastDays] = useState<30 | 60 | 90>(30);
  const [scenario, setScenario] = useState<ForecastScenario>({
    churn_rate_adjustment: 0,
    growth_rate_adjustment: 0,
  });

  // Calculate churn metrics
  const churnMetrics = useMemo<ChurnMetrics>(() => 
    calculateChurnMetrics(subscriptions, historicalChurn),
    [subscriptions, historicalChurn]
  );

  // Generate forecast
  const forecast = useMemo<RevenueForecast>(() => 
    projectRevenue(subscriptions, churnMetrics, forecastDays, scenario),
    [subscriptions, churnMetrics, forecastDays, scenario]
  );

  // Generate calendar
  const calendar = useMemo(() => 
    generateRenewalCalendar(subscriptions, forecastDays),
    [subscriptions, forecastDays]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b border-gray-200 pb-4">
        <h1 className="text-2xl font-semibold text-gray-900">Revenue Forecasting</h1>
        <p className="mt-1 text-sm text-gray-600">
          Predictive cash flow and churn modeling based on subscription renewals
        </p>
      </div>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Active Subscribers"
          value={churnMetrics.total_active_subscribers.toString()}
          subtitle="Current active subscriptions"
        />
        <MetricCard
          title="Monthly Churn Rate"
          value={formatPercentage(churnMetrics.monthly_churn_rate)}
          subtitle="Last 30 days"
          trend={churnMetrics.monthly_churn_rate > 5 ? 'negative' : 'positive'}
        />
        <MetricCard
          title="Projected MRR"
          value={formatCurrency(forecast.average_mrr)}
          subtitle={`Next ${forecastDays} days average`}
        />
        <MetricCard
          title="Forecast Confidence"
          value={`${(forecast.confidence_level * 100).toFixed(0)}%`}
          subtitle="Based on historical data"
        />
      </div>

      {/* Scenario Controls */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Interactive Scenario Modeling</h2>
        <div className="space-y-4">
          {/* Forecast Period Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Forecast Period
            </label>
            <div className="flex gap-2">
              {([30, 60, 90] as const).map((days) => (
                <button
                  key={days}
                  onClick={() => setForecastDays(days)}
                  className={`px-4 py-2 text-sm font-medium rounded-md ${
                    forecastDays === days
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {days} Days
                </button>
              ))}
            </div>
          </div>

          {/* Churn Rate Adjustment Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Expected Churn Rate: {formatPercentage(churnMetrics.monthly_churn_rate * (1 + scenario.churn_rate_adjustment / 100))}
              <span className="ml-2 text-gray-500">
                ({scenario.churn_rate_adjustment > 0 ? '+' : ''}{scenario.churn_rate_adjustment}%)
              </span>
            </label>
            <input
              type="range"
              min="-50"
              max="50"
              step="5"
              value={scenario.churn_rate_adjustment}
              onChange={(e) => setScenario({
                ...scenario,
                churn_rate_adjustment: Number(e.target.value),
              })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>-50% (Better)</span>
              <span>Baseline</span>
              <span>+50% (Worse)</span>
            </div>
          </div>

          {/* Growth Rate Adjustment Slider */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              New Subscriber Growth Rate: {formatPercentage(scenario.growth_rate_adjustment)}
              /month
            </label>
            <input
              type="range"
              min="-10"
              max="20"
              step="1"
              value={scenario.growth_rate_adjustment}
              onChange={(e) => setScenario({
                ...scenario,
                growth_rate_adjustment: Number(e.target.value),
              })}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>-10% (Decline)</span>
              <span>0% (Flat)</span>
              <span>+20% (Growth)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Forecast Chart */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Projected Cash Flow Trajectory</h2>
        <ForecastChart forecast={forecast} />
      </div>

      {/* Renewal Calendar */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Upcoming Settlement Calendar</h2>
        <RenewalCalendar events={calendar} />
      </div>
    </div>
  );
}

function MetricCard({ 
  title, 
  value, 
  subtitle, 
  trend 
}: { 
  title: string; 
  value: string; 
  subtitle: string; 
  trend?: 'positive' | 'negative' 
}) {
  return (
    <div className="bg-white overflow-hidden shadow rounded-lg">
      <div className="p-5">
        <div className="flex items-center">
          <div className="flex-1">
            <dt className="text-sm font-medium text-gray-500 truncate">{title}</dt>
            <dd className="mt-1 text-3xl font-semibold text-gray-900">{value}</dd>
          </div>
          {trend && (
            <div className={`ml-2 flex items-center text-sm ${
              trend === 'positive' ? 'text-green-600' : 'text-red-600'
            }`}>
              {trend === 'positive' ? '↓' : '↑'}
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500">{subtitle}</p>
      </div>
    </div>
  );
}

function ForecastChart({ forecast }: { forecast: RevenueForecast }) {
  const maxMRR = Math.max(...forecast.periods.map(p => p.projected_mrr));
  const maxCashFlow = Math.max(...forecast.periods.map(p => p.projected_cash_flow));
  const chartHeight = 200;

  // Sample every Nth period for readable x-axis
  const sampleRate = Math.ceil(forecast.periods.length / 10);

  return (
    <div className="relative">
      <svg width="100%" height={chartHeight} className="overflow-visible">
        {/* Y-axis grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            y1={chartHeight * (1 - ratio)}
            x2="100%"
            y2={chartHeight * (1 - ratio)}
            stroke="#e5e7eb"
            strokeWidth="1"
          />
        ))}

        {/* MRR Line */}
        <polyline
          fill="none"
          stroke="#3b82f6"
          strokeWidth="2"
          points={forecast.periods
            .map((p, i) => {
              const x = (i / (forecast.periods.length - 1)) * 100;
              const y = chartHeight * (1 - p.projected_mrr / maxMRR);
              return `${x}%,${y}`;
            })
            .join(' ')}
        />

        {/* Cash Flow Bars */}
        {forecast.periods.map((p, i) => {
          const x = (i / (forecast.periods.length - 1)) * 100;
          const barHeight = (p.projected_cash_flow / maxCashFlow) * chartHeight * 0.8;
          const y = chartHeight - barHeight;
          return (
            <rect
              key={i}
              x={`${x}%`}
              y={y}
              width="1%"
              height={barHeight}
              fill="#10b981"
              opacity="0.3"
            />
          );
        })}
      </svg>

      {/* Legend */}
      <div className="mt-4 flex items-center justify-center gap-6 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-0.5 bg-blue-600"></div>
          <span>Projected MRR</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-2 bg-green-500 opacity-30"></div>
          <span>Daily Cash Flow</span>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-gray-500">Total Projected Revenue:</span>
          <span className="ml-2 font-semibold">{formatCurrency(forecast.total_projected_revenue)}</span>
        </div>
        <div>
          <span className="text-gray-500">Average MRR:</span>
          <span className="ml-2 font-semibold">{formatCurrency(forecast.average_mrr)}</span>
        </div>
      </div>
    </div>
  );
}

function RenewalCalendar({ events }: { events: Array<{ date: Date; renewal_count: number; total_volume: number }> }) {
  const [selectedMonth, setSelectedMonth] = useState(new Date());

  // Group events by month
  const monthlyEvents = useMemo(() => {
    const grouped = new Map<string, typeof events>();
    
    for (const event of events) {
      const monthKey = `${event.date.getFullYear()}-${event.date.getMonth()}`;
      if (!grouped.has(monthKey)) {
        grouped.set(monthKey, []);
      }
      grouped.get(monthKey)!.push(event);
    }
    
    return grouped;
  }, [events]);

  const currentMonthKey = `${selectedMonth.getFullYear()}-${selectedMonth.getMonth()}`;
  const currentMonthEvents = monthlyEvents.get(currentMonthKey) || [];

  // Generate calendar grid
  const firstDay = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
  const lastDay = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  const calendarDays = Array.from({ length: 42 }, (_, i) => {
    const dayNum = i - startingDayOfWeek + 1;
    if (dayNum < 1 || dayNum > daysInMonth) return null;
    
    const date = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), dayNum);
    const event = currentMonthEvents.find(
      e => e.date.toDateString() === date.toDateString()
    );
    
    return { dayNum, date, event };
  });

  return (
    <div>
      {/* Month Navigator */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => {
            const prev = new Date(selectedMonth);
            prev.setMonth(prev.getMonth() - 1);
            setSelectedMonth(prev);
          }}
          className="px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded"
        >
          Previous
        </button>
        <h3 className="text-lg font-semibold">
          {selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </h3>
        <button
          onClick={() => {
            const next = new Date(selectedMonth);
            next.setMonth(next.getMonth() + 1);
            setSelectedMonth(next);
          }}
          className="px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded"
        >
          Next
        </button>
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
          <div key={day} className="text-center text-xs font-semibold text-gray-700 p-2">
            {day}
          </div>
        ))}
        
        {calendarDays.map((day, i) => (
          <div
            key={i}
            className={`min-h-[80px] border border-gray-200 p-2 ${
              day ? 'bg-white hover:bg-gray-50' : 'bg-gray-50'
            } ${day?.event ? 'bg-blue-50 border-blue-300' : ''}`}
          >
            {day && (
              <>
                <div className="text-sm font-medium text-gray-900">{day.dayNum}</div>
                {day.event && (
                  <div className="mt-1">
                    <div className="text-xs font-semibold text-blue-600">
                      {day.event.renewal_count} renewals
                    </div>
                    <div className="text-xs text-gray-600">
                      {formatCurrency(day.event.total_volume)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
