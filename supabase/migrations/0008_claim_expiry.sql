-- Free expired reservations. A 'reserved' row whose 24h start window lapsed (and was
-- never started) otherwise blocks re-claim forever via UNIQUE(subject_type,subject_id),
-- since claim_play's INSERT … ON CONFLICT DO NOTHING can't overwrite it. Fix it inside
-- the RPC: drop any expired-reserved row for this subject before inserting, so the next
-- claimer wins it cleanly. Idempotent (CREATE OR REPLACE).
create or replace function claim_play(
  p_subject_type text,
  p_subject_id   text,
  p_subject_name text,
  p_category     text,
  p_manager      text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      play_claims;
  v_existing play_claims;
begin
  -- release a lapsed, never-started reservation so it can be re-claimed
  delete from play_claims
   where subject_type = p_subject_type and subject_id = p_subject_id
     and status = 'reserved' and started_at is null and start_by < now();

  insert into play_claims (subject_type, subject_id, subject_name, category, manager_name, status, claimed_at, start_by)
  values (p_subject_type, p_subject_id, p_subject_name, p_category, p_manager, 'reserved', now(), now() + interval '24 hours')
  on conflict (subject_type, subject_id) do nothing
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('won', true, 'claim', to_jsonb(v_row));
  end if;

  select * into v_existing from play_claims
   where subject_type = p_subject_type and subject_id = p_subject_id;
  return jsonb_build_object('won', false, 'claimed_by', v_existing.manager_name, 'claim', to_jsonb(v_existing));
end;
$$;
