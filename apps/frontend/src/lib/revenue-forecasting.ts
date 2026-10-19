/**
 * Revenue Forecasting and Predictive Churn Modeling (#178)
 * 
 * Provides forward-looking visibility into projected cash flow, renewal probabilities,
 * and revenue forecasting based on historical churn trends.
 */

export interface Subscription {
  id: string;
  amount: number;
  interval_seconds: number;
  last_pull_timestamp: number;
  created_at: string;
  status: 'active' | 'paused' | 'defaulted';
}

export interface ChurnMetrics {
  monthly_churn_rate: number; // percentage (0-100)
  total_active_subscribers: number;
  churned_last_30_days: number;
  churned_last_60_days: number;
  churned_last_90_days: number;
}

export interface ForecastScenario {
  churn_rate_adjustment: number; // percentage adjustment (-100 to +100)
  growth_rate_adjustment: number; // percentage adjustment (-100 to +100)
}

export interface ForecastPeriod {
  date: Date;
  projected_mrr: number;
  projected_cash_flow: number;
  active_subscribers: number;
  new_subscribers: number;
  churned_subscribers: number;
  renewal_count: number;
}

export interface RevenueForecast {
  periods: ForecastPeriod[];
  total_projected_revenue: number;
  average_mrr: number;
  confidence_level: number; // 0-1
}

export interface RenewalEvent {
  subscriber_id: string;
  renewal_date: Date;
  amount: number;
  subscription_id: string;
}

/**
 * Calculate historical churn rate from subscription data
 */
export function calculateChurnMetrics(
  subscriptions: Subscription[],
  historicalData: {
    churned_30d: number;
    churned_60d: number;
    churned_90d: number;
  }
): ChurnMetrics {
  const activeSubscribers = subscriptions.filter(s => s.status === 'active').length;
  
  // Calculate monthly churn rate based on last 30 days
  const monthly_churn_rate = activeSubscribers > 0 
    ? (historicalData.churned_30d / activeSubscribers) * 100 
    : 0;

  return {
    monthly_churn_rate: Math.min(monthly_churn_rate, 100),
    total_active_subscribers: activeSubscribers,
    churned_last_30_days: historicalData.churned_30d,
    churned_last_60_days: historicalData.churned_60d,
    churned_last_90_days: historicalData.churned_90d,
  };
}

/**
 * Calculate next renewal dates for all active subscriptions
 */
export function calculateRenewalSchedule(subscriptions: Subscription[]): RenewalEvent[] {
  const now = Date.now() / 1000; // Current timestamp in seconds
  const renewals: RenewalEvent[] = [];

  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;

    // Calculate next renewal timestamp
    const lastPull = sub.last_pull_timestamp || now;
    const nextRenewal = lastPull + sub.interval_seconds;
    
    renewals.push({
      subscriber_id: sub.id,
      renewal_date: new Date(nextRenewal * 1000),
      amount: sub.amount,
      subscription_id: sub.id,
    });
  }

  return renewals.sort((a, b) => a.renewal_date.getTime() - b.renewal_date.getTime());
}

/**
 * Project revenue for the next N days based on renewal schedule and churn rate
 */
export function projectRevenue(
  subscriptions: Subscription[],
  churnMetrics: ChurnMetrics,
  daysForward: number,
  scenario: ForecastScenario = { churn_rate_adjustment: 0, growth_rate_adjustment: 0 }
): RevenueForecast {
  const periodsPerDay = 1;
  const periods: ForecastPeriod[] = [];
  
  // Apply scenario adjustments
  const adjusted_churn_rate = Math.max(0, Math.min(100, 
    churnMetrics.monthly_churn_rate * (1 + scenario.churn_rate_adjustment / 100)
  ));
  
  const daily_churn_rate = adjusted_churn_rate / 30; // Convert monthly to daily
  const monthly_growth_rate = scenario.growth_rate_adjustment;
  const daily_growth_rate = monthly_growth_rate / 30;

  // Get initial active subscribers and renewals
  let activeSubscribers = churnMetrics.total_active_subscribers;
  const renewalSchedule = calculateRenewalSchedule(subscriptions);
  
  // Calculate average subscription value
  const avgSubscriptionValue = subscriptions.length > 0
    ? subscriptions.reduce((sum, s) => sum + s.amount, 0) / subscriptions.length
    : 0;

  let totalProjectedRevenue = 0;
  const startDate = new Date();

  for (let day = 0; day < daysForward; day++) {
    const periodDate = new Date(startDate);
    periodDate.setDate(periodDate.getDate() + day);
    
    // Calculate renewals for this day
    const dayStart = periodDate.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    
    const renewalsToday = renewalSchedule.filter(r => {
      const renewalTime = r.renewal_date.getTime();
      return renewalTime >= dayStart && renewalTime < dayEnd;
    });
    
    const renewal_count = renewalsToday.length;
    const projected_cash_flow = renewalsToday.reduce((sum, r) => sum + r.amount, 0);
    
    // Calculate churn for this day
    const churned_today = Math.round(activeSubscribers * (daily_churn_rate / 100));
    
    // Calculate new subscribers for this day
    const new_subscribers_today = Math.round(activeSubscribers * (daily_growth_rate / 100));
    
    // Update active subscriber count
    activeSubscribers = activeSubscribers - churned_today + new_subscribers_today;
    activeSubscribers = Math.max(0, activeSubscribers);
    
    // Calculate MRR (Monthly Recurring Revenue)
    const projected_mrr = activeSubscribers * avgSubscriptionValue;
    
    totalProjectedRevenue += projected_cash_flow;
    
    periods.push({
      date: periodDate,
      projected_mrr,
      projected_cash_flow,
      active_subscribers: activeSubscribers,
      new_subscribers: new_subscribers_today,
      churned_subscribers: churned_today,
      renewal_count,
    });
  }

  // Calculate average MRR
  const average_mrr = periods.reduce((sum, p) => sum + p.projected_mrr, 0) / periods.length;
  
  // Confidence level decreases as we project further out
  const confidence_level = Math.max(0.3, 1 - (daysForward / 365));

  return {
    periods,
    total_projected_revenue: totalProjectedRevenue,
    average_mrr,
    confidence_level,
  };
}

/**
 * Generate calendar view of upcoming settlement spikes
 */
export interface CalendarEvent {
  date: Date;
  renewal_count: number;
  total_volume: number;
  peak_hour?: number;
}

export function generateRenewalCalendar(
  subscriptions: Subscription[],
  daysForward: number = 90
): CalendarEvent[] {
  const renewals = calculateRenewalSchedule(subscriptions);
  const calendar: Map<string, CalendarEvent> = new Map();

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + daysForward);

  for (const renewal of renewals) {
    if (renewal.renewal_date > endDate) continue;

    const dateKey = renewal.renewal_date.toISOString().split('T')[0];
    
    if (!calendar.has(dateKey)) {
      calendar.set(dateKey, {
        date: new Date(dateKey),
        renewal_count: 0,
        total_volume: 0,
      });
    }

    const event = calendar.get(dateKey)!;
    event.renewal_count++;
    event.total_volume += renewal.amount;
  }

  return Array.from(calendar.values()).sort((a, b) => 
    a.date.getTime() - b.date.getTime()
  );
}

/**
 * Format currency for display
 */
export function formatCurrency(amount: number, decimals: number = 7): string {
  return (amount / Math.pow(10, decimals)).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format percentage for display
 */
export function formatPercentage(value: number): string {
  return `${value.toFixed(2)}%`;
}
