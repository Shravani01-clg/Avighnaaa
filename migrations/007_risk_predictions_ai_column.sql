-- ============================================================
-- AVIGHNAA — Migration 007
-- Adds the optional `ai` column to risk_predictions so the AI
-- explainability payload can be persisted with each risk reading.
--
-- The payload written by controllers/sensorController.js is the
-- object returned by controllers/aiIntegration.js:
--   source, aiAvailable, recommendation, mlRiskPrediction,
--   mlConfidence, mlProbabilities, anomalyDetected, anomalyScore,
--   combinedScore, aiRiskFactors, stuckSensors, trendWarnings
--
-- SAFE TO RUN TWICE. No placeholders, no fake uuids.
-- Run in: Supabase Dashboard > SQL Editor > paste this file > Run
-- ============================================================

alter table public.risk_predictions
  add column if not exists ai jsonb;

comment on column public.risk_predictions.ai is
  'AI explainability payload for this reading (ML prediction, risk factors, recommendation, stuck sensors, trend warnings)';
