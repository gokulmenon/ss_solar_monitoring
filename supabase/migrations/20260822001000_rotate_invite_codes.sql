-- Rotate the available OAuth invite codes as one transaction. Used codes remain
-- intact for audit history; only still-redeemable codes are revoked.
create or replace function public.rotate_invite_codes(
  p_batch_size integer default 5,
  p_year integer default extract(year from now())::integer
)
returns setof public.invite_codes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_sequence integer;
begin
  if p_batch_size < 1 or p_batch_size > 100 then
    raise exception 'Batch size must be between 1 and 100.';
  end if;

  -- Serialise rotations so two administrator requests can never issue the
  -- same sequence number.
  perform pg_advisory_xact_lock(hashtext('public.rotate_invite_codes'));

  update public.invite_codes
  set is_revoked = true,
      revoked_at = now()
  where is_used = false
    and is_revoked = false;

  select coalesce(
    max((regexp_match(code, '^SS-INVITE([0-9]+)-' || p_year::text || '$'))[1]::integer),
    0
  )
  into v_last_sequence
  from public.invite_codes
  where code ~ ('^SS-INVITE[0-9]+-' || p_year::text || '$');

  return query
    insert into public.invite_codes (code)
    select format('SS-INVITE%s-%s', v_last_sequence + sequence_number, p_year)
    from generate_series(1, p_batch_size) as sequence_number
    returning public.invite_codes.*;
end;
$$;
