import { createClient } from '@supabase/supabase-js'
import { createAnalyticsRouter } from '../_lib/analytics-router.js'
import { createAnalyticsDispatchHandler } from '../_lib/analytics-dispatch-handler.js'
import { createAnalyticsPreferenceHandler } from '../_lib/analytics-preference-handler.js'
import { createAnalyticsReadinessHandler } from '../_lib/analytics-readiness-handler.js'

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

export const config = { maxDuration: 60 }

export default createAnalyticsRouter({
  dispatch: createAnalyticsDispatchHandler(supabase),
  preference: createAnalyticsPreferenceHandler(supabase),
  readiness: createAnalyticsReadinessHandler(supabase),
})
