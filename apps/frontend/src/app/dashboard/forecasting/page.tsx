'use client';

import { useEffect, useState } from 'react';
import { RevenueForecastingView } from '@/components/dashboard/revenue-forecasting';
import type { Subscription } from '@/lib/revenue-forecasting';

export default function ForecastingPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [historicalChurn, setHistoricalChurn] = useState({
    churned_30d: 0,
    churned_60d: 0,
    churned_90d: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        // Fetch active subscriptions
        const subsResponse = await fetch('/api/subscriptions/active');
        const subsData = await subsResponse.json();
        
        // Fetch churn metrics
        const churnResponse = await fetch('/api/analytics/churn');
        const churnData = await churnResponse.json();
        
        setSubscriptions(subsData);
        setHistoricalChurn(churnData);
      } catch (error) {
        console.error('Failed to load forecasting data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading forecast data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <RevenueForecastingView 
        subscriptions={subscriptions}
        historicalChurn={historicalChurn}
      />
    </div>
  );
}
