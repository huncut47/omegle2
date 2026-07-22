require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await sb.from('friendships')
      .select('id, status')
      .or(`and(requester_id.eq.48e7ce1a-0000-0000-0000-000000000000,receiver_id.eq.e10c0000-0000-0000-0000-000000000000),and(requester_id.eq.e10c0000-0000-0000-0000-000000000000,receiver_id.eq.48e7ce1a-0000-0000-0000-000000000000)`);
  console.log('Data:', data);
  console.log('Error:', error);
}
run();
