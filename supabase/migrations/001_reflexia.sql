-- ReflexIA: run once in a new Supabase project, using the SQL editor.
-- Private tables have no browser grants. Public RPCs enforce membership and state transitions.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists reflexia_private;
revoke all on schema reflexia_private from public, anon, authenticated;

create table reflexia_private.sessions (
  id uuid primary key default gen_random_uuid(),
  invitation_hash bytea not null,
  attack_ids jsonb not null default '["verification","governance","privacy","security"]',
  expires_at timestamptz not null,
  state jsonb not null,
  check (jsonb_typeof(state) = 'object'),
  check (jsonb_typeof(attack_ids) = 'array' and jsonb_array_length(attack_ids)>0)
);
create table reflexia_private.members (
  session_id uuid not null references reflexia_private.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (session_id, user_id)
);
create table reflexia_private.requests (
  session_id uuid not null references reflexia_private.sessions(id) on delete cascade,
  actor_id uuid not null,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, actor_id, request_id)
);
alter table reflexia_private.sessions enable row level security;
alter table reflexia_private.members enable row level security;
alter table reflexia_private.requests enable row level security;
-- Deliberately no direct-table policies: only vetted SECURITY DEFINER RPCs can access data.
revoke all on all tables in schema reflexia_private from public, anon, authenticated;

-- Replace one element without changing order. Only used by the server-side reducer.
create function reflexia_private.replace_at(p_items jsonb, p_position integer, p_replacement jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(case when n - 1 = p_position then p_replacement else v end order by n), '[]'::jsonb)
  from jsonb_array_elements(p_items) with ordinality as t(v,n);
$$;

-- One-time backend setup: returns one shared invitation. No application administrator exists.
create function reflexia_private.create_session(retention_hours integer default 24,
  p_attack_ids jsonb default '["verification","governance","privacy","security"]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  sid uuid := gen_random_uuid();
  invitation text := encode(extensions.gen_random_bytes(24), 'hex');
  expiry timestamptz;
begin
  if retention_hours < 1 or retention_hours > 720 then
    raise exception 'La retención debe ser de 1 a 720 horas.';
  end if;
  if p_attack_ids is null or jsonb_typeof(p_attack_ids)<>'array' then raise exception 'El mazo debe ser una lista.'; end if;
  if jsonb_array_length(p_attack_ids) not between 1 and 100 or
    exists(select 1 from jsonb_array_elements(p_attack_ids)v where jsonb_typeof(v)<>'string' or (v#>>'{}') !~ '^[a-zA-Z0-9_-]{1,80}$') or
    (select count(distinct v) from jsonb_array_elements_text(p_attack_ids)v)<>jsonb_array_length(p_attack_ids) then
    raise exception 'El mazo debe contener identificadores únicos y válidos.';
  end if;
  expiry := now() + make_interval(hours => retention_hours);
  insert into reflexia_private.sessions(id, invitation_hash, attack_ids, expires_at, state)
  values (sid, extensions.digest(invitation, 'sha256'), p_attack_ids, expiry,
    jsonb_build_object('id',sid,'createdAt',now(),'expiresAt',expiry,'phase','selection',
      'organizerId',null,'reportEnabled',false,'participants','[]'::jsonb,'teams','[]'::jsonb,
      'turns','[]'::jsonb,'contributions','[]'::jsonb,'revision',0));
  return jsonb_build_object('sessionId',sid,'invitationToken',invitation,'expiresAt',expiry);
end;
$$;

create function public.reflexia_join(p_session uuid, p_invitation text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  room reflexia_private.sessions%rowtype;
  actor uuid := auth.uid();
  participant jsonb;
  new_state jsonb;
begin
  if actor is null then raise exception 'Inicia una sesión anónima.' using errcode='42501'; end if;
  select * into room from reflexia_private.sessions where id=p_session for update;
  if not found or room.expires_at <= now() then raise exception 'Esta actividad no existe o venció.'; end if;
  if p_invitation is null or extensions.digest(p_invitation,'sha256') <> room.invitation_hash then
    raise exception 'El enlace de invitación no es válido.' using errcode='42501';
  end if;
  new_state := room.state;
  if not exists(select 1 from reflexia_private.members where session_id=p_session and user_id=actor) then
    if room.state->>'phase' <> 'selection' then raise exception 'La selección de esta actividad ya se cerró.'; end if;
    if p_name is null or length(btrim(p_name)) < 1 or length(btrim(p_name)) > 80 then
      raise exception 'Escribe un nombre de entre 1 y 80 caracteres.';
    end if;
    if jsonb_array_length(room.state->'participants') >= 200 then raise exception 'La actividad está llena.'; end if;
    participant := jsonb_build_object('id',actor,'name',btrim(p_name),'cards','[]'::jsonb,'confirmed',false,'joinedAt',now());
    new_state := jsonb_set(new_state,'{participants}',(new_state->'participants') || jsonb_build_array(participant));
    insert into reflexia_private.members(session_id,user_id) values(p_session,actor);
  end if;
  if new_state <> room.state then
    new_state := jsonb_set(new_state,'{revision}',to_jsonb((room.state->>'revision')::integer+1));
    update reflexia_private.sessions set state=new_state where id=p_session;
  end if;
  return jsonb_build_object('participantId',actor,'state',new_state);
end;
$$;

create function public.reflexia_state(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists(select 1 from reflexia_private.members where session_id=p_session and user_id=auth.uid()) then
    raise exception 'No perteneces a esta actividad.' using errcode='42501';
  end if;
  select state into result from reflexia_private.sessions where id=p_session and expires_at > now();
  if result is null then raise exception 'La actividad venció.'; end if;
  return result;
end;
$$;

create function public.reflexia_action(p_session uuid, p_type text, p_payload jsonb default '{}', p_request uuid default gen_random_uuid())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  room reflexia_private.sessions%rowtype;
  s jsonb;
  actor uuid := auth.uid();
  actor_text text;
  person jsonb;
  person_idx integer;
  team jsonb;
  team_idx integer;
  turn jsonb;
  turn_idx integer;
  note jsonb;
  note_idx integer;
  cards jsonb;
  teams jsonb;
  proposed jsonb;
  candidate jsonb;
  seed jsonb;
  ids jsonb;
  taken jsonb := '[]';
  remaining jsonb;
  turns jsonb;
  pending jsonb;
  attacks jsonb;
  used_attacks jsonb;
  deck_size integer;
  selected text;
  n integer;
  group_count integer;
  group_size integer;
  i integer;
  j integer;
  candidate_score integer;
  best_score integer;
  pick_idx integer;
  field record;
begin
  actor_text := actor::text;
  if actor is null or not exists(select 1 from reflexia_private.members where session_id=p_session and user_id=actor) then
    raise exception 'No perteneces a esta actividad.' using errcode='42501';
  end if;
  select * into room from reflexia_private.sessions where id=p_session for update;
  if not found or room.expires_at <= now() then raise exception 'La actividad venció.'; end if;
  s := room.state;
  if exists(select 1 from reflexia_private.requests where session_id=p_session and actor_id=actor and request_id=p_request) then return s; end if;
  if p_request is null then raise exception 'Falta el identificador de operación.'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text)>400000 then raise exception 'Datos inválidos.'; end if;
  select v, (ordinality-1)::integer into person,person_idx from jsonb_array_elements(s->'participants') with ordinality as t(v,ordinality) where v->>'id'=actor_text;
  if person is null then raise exception 'Participante no encontrado.'; end if;

  if p_type in ('select','confirm') then
    if s->>'phase' <> 'selection' or (person->>'confirmed')::boolean then raise exception 'La selección está cerrada.'; end if;
    cards := case when p_type='select' then p_payload->'cards' else person->'cards' end;
    if cards is null or jsonb_typeof(cards)<>'array' or jsonb_array_length(cards)>2 then raise exception 'Elige como máximo dos cartas.'; end if;
    if exists(select 1 from jsonb_array_elements_text(cards) c where c not in ('builders','designers','optimizers','explorers'))
       or (select count(distinct c) from jsonb_array_elements_text(cards)c)<>jsonb_array_length(cards) then raise exception 'Cartas inválidas o repetidas.'; end if;
    if p_type='confirm' and jsonb_array_length(cards)<>2 then raise exception 'Debes confirmar exactamente dos cartas.'; end if;
    person := jsonb_set(person,'{cards}',cards);
    if p_type='confirm' then person := jsonb_set(person,'{confirmed}','true'); end if;
    s := jsonb_set(s,'{participants}',reflexia_private.replace_at(s->'participants',person_idx,person));

  elsif p_type='formTeams' then
    if s->>'phase'<>'selection' then raise exception 'Los equipos ya se formaron.'; end if;
    remaining := s->'participants'; n := jsonb_array_length(remaining);
    if n<2 then raise exception 'Se necesitan al menos dos participantes.'; end if;
    if exists(select 1 from jsonb_array_elements(remaining)p where not (p->>'confirmed')::boolean) then raise exception 'Faltan selecciones por confirmar.'; end if;
    group_count := ceil(n/5.0); teams := '[]';
    for i in 1..group_count loop
      group_size := n/group_count + case when i<=n%group_count then 1 else 0 end;
      seed := remaining->0; ids := jsonb_build_array(seed->>'id');
      remaining := remaining-0;
      for j in 2..group_size loop
        best_score := -1; pick_idx := 0;
        for candidate, candidate_score in
          select v,(ordinality-1)::integer from jsonb_array_elements(remaining) with ordinality as t(v,ordinality)
        loop
          select count(*) into n from jsonb_array_elements_text(seed->'cards')c where candidate->'cards' ? c;
          if n>best_score then best_score := n; pick_idx := candidate_score; end if;
        end loop;
        ids := ids || jsonb_build_array(remaining->pick_idx->>'id');
        remaining := remaining-pick_idx;
      end loop;
      teams := teams || jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'name','Equipo '||i,'memberIds',ids,'status','ready','currentTurnId',null));
      n := jsonb_array_length(s->'participants');
    end loop;
    s := jsonb_set(jsonb_set(s,'{teams}',teams),'{phase}','"teams"');

  elsif p_type='updateTeams' then
    if s->>'phase'<>'teams' then raise exception 'Sólo puedes ajustar equipos antes de iniciar.'; end if;
    proposed := p_payload->'teams';
    if proposed is null or jsonb_typeof(proposed)<>'array' or jsonb_array_length(proposed)<1 then raise exception 'Faltan los equipos.'; end if;
    teams := '[]'; ids := '[]';
    for candidate in select value from jsonb_array_elements(proposed) loop
      if candidate->'memberIds' is null or jsonb_typeof(candidate->'memberIds')<>'array' then raise exception 'Faltan los integrantes del equipo.'; end if;
      if jsonb_array_length(candidate->'memberIds') not between 2 and 5 then raise exception 'Cada equipo debe tener de 2 a 5 integrantes.'; end if;
      if exists(select 1 from jsonb_array_elements(candidate->'memberIds')m where jsonb_typeof(m)<>'string') then raise exception 'Integrantes inválidos.'; end if;
      if candidate->>'name' is null or length(btrim(candidate->>'name')) not between 1 and 80 then raise exception 'Nombre de equipo inválido.'; end if;
      -- Preserve only supplied names and membership. IDs are assigned server-side.
      ids := ids || (candidate->'memberIds');
      teams := teams || jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'name',btrim(candidate->>'name'),'memberIds',candidate->'memberIds','status','ready','currentTurnId',null));
    end loop;
    if jsonb_array_length(ids)<>jsonb_array_length(s->'participants') or
      (select count(distinct v) from jsonb_array_elements_text(ids)v)<>jsonb_array_length(ids) or
      exists(select 1 from jsonb_array_elements_text(ids)v where not exists(select 1 from jsonb_array_elements(s->'participants')p where p->>'id'=v)) then
      raise exception 'Cada participante debe pertenecer a exactamente un equipo.';
    end if;
    s := jsonb_set(s,'{teams}',teams);

  elsif p_type='startSession' then
    if s->>'phase'<>'teams' or jsonb_array_length(s->'teams')=0 then raise exception 'Confirma los equipos antes de iniciar.'; end if;
    s := jsonb_set(s,'{phase}','"conversation"');

  elsif p_type='finishSession' then
    if s->>'phase' not in ('conversation','finished') then raise exception 'La dinámica no está en curso.'; end if;
    if exists(select 1 from jsonb_array_elements(s->'teams')t where t->>'status'<>'finished') then raise exception 'Todavía quedan participantes por compartir.'; end if;
    s := jsonb_set(jsonb_set(jsonb_set(s,'{phase}','"finished"'),'{reportEnabled}','true'),'{finishedAt}',coalesce(s->'finishedAt',to_jsonb(now())));

  elsif p_type='enableReport' then
    if s->>'phase'<>'finished' then raise exception 'Finaliza la actividad antes de habilitar el reporte.'; end if;
    s := jsonb_set(s,'{reportEnabled}','true');

  elsif p_type in ('spin','drawAttack','finishTurn','saveContribution') then
    if s->>'phase' not in ('conversation','finished') then raise exception 'La dinámica no ha iniciado.'; end if;
    if s->>'phase'='finished' and p_type not in ('saveContribution','finishTurn') then raise exception 'La actividad ya terminó.'; end if;
    if p_type='saveContribution' then
      select v,(ordinality-1)::integer into turn,turn_idx from jsonb_array_elements(s->'turns') with ordinality as t(v,ordinality) where v->>'id'=p_payload->>'turnId';
      if turn is null then raise exception 'Turno no encontrado.'; end if;
      select v,(ordinality-1)::integer into team,team_idx from jsonb_array_elements(s->'teams') with ordinality as t(v,ordinality) where v->>'id'=turn->>'teamId';
    else
      select v,(ordinality-1)::integer into team,team_idx from jsonb_array_elements(s->'teams') with ordinality as t(v,ordinality) where v->>'id'=p_payload->>'teamId';
    end if;
    if team is null then raise exception 'Equipo no encontrado.'; end if;
    -- Every member has equal permissions, always restricted to their own team.
    if not (team->'memberIds' ? actor_text) then
      raise exception 'No puedes intervenir en otro equipo.' using errcode='42501';
    end if;
    if p_type='spin' then
      if team->>'currentTurnId' is not null or team->>'status'='finished' then
        insert into reflexia_private.requests(session_id,actor_id,request_id) values(p_session,actor,p_request);
        return s;
      end if;
      select coalesce(jsonb_agg(to_jsonb(member)), '[]') into pending
        from jsonb_array_elements_text(team->'memberIds') member
        where not exists(select 1 from jsonb_array_elements(s->'turns')t where t->>'teamId'=team->>'id' and t->>'participantId'=member);
      if jsonb_array_length(pending)=0 then raise exception 'Todas las personas de este equipo ya participaron.'; end if;
      selected := pending->>(floor(random()*jsonb_array_length(pending)))::integer;
      select count(*)+1 into n from jsonb_array_elements(s->'turns')t where t->>'teamId'=team->>'id';
      turn := jsonb_build_object('id',gen_random_uuid(),'teamId',team->>'id','participantId',selected,'number',n,'attackId',null,'status','active','createdAt',now());
      team := jsonb_set(jsonb_set(team,'{currentTurnId}',turn->'id'),'{status}','"attack"');
      s := jsonb_set(s,'{turns}',(s->'turns') || jsonb_build_array(turn));
      s := jsonb_set(s,'{teams}',reflexia_private.replace_at(s->'teams',team_idx,team));
    elsif p_type='drawAttack' then
      select v,(ordinality-1)::integer into turn,turn_idx from jsonb_array_elements(s->'turns') with ordinality as t(v,ordinality) where v->>'id'=team->>'currentTurnId';
      if turn is null or turn->>'participantId'<>actor_text then raise exception 'La carta la elige quien está compartiendo.' using errcode='42501'; end if;
      if turn->>'attackId' is not null then
        insert into reflexia_private.requests(session_id,actor_id,request_id) values(p_session,actor,p_request);
        return s;
      end if;
      if team->>'status'<>'attack' then raise exception 'No es momento de revelar una carta.'; end if;
      attacks := room.attack_ids;
      deck_size := jsonb_array_length(attacks);
      -- Each session freezes its configured deck; only the incomplete cycle is excluded.
      select count(*) into n from jsonb_array_elements(s->'turns')t where t->>'teamId'=team->>'id' and t->>'attackId' is not null;
      select coalesce(jsonb_agg(t->'attackId'), '[]') into used_attacks from jsonb_array_elements(s->'turns')t
        where t->>'teamId'=team->>'id' and t->>'attackId' is not null and (t->>'number')::integer > n-(n%deck_size);
      select jsonb_agg(to_jsonb(a)) into remaining from jsonb_array_elements_text(attacks)a where not used_attacks ? a;
      selected := remaining->>(floor(random()*jsonb_array_length(remaining)))::integer;
      turn := jsonb_set(turn,'{attackId}',to_jsonb(selected));
      team := jsonb_set(team,'{status}','"recording"');
      s := jsonb_set(s,'{turns}',reflexia_private.replace_at(s->'turns',turn_idx,turn));
      s := jsonb_set(s,'{teams}',reflexia_private.replace_at(s->'teams',team_idx,team));
    elsif p_type='saveContribution' then
      if turn->>'attackId' is null then raise exception 'Primero revela la carta de ataque.'; end if;
      if p_payload->'fields' is null or jsonb_typeof(p_payload->'fields')<>'object' then raise exception 'Falta el contenido de la aportación.'; end if;
      for field in select key,value from jsonb_each(p_payload->'fields') loop
        if jsonb_typeof(field.value)<>'string' or length(field.value#>>'{}')>50000 then raise exception 'Los campos deben contener texto de hasta 50.000 caracteres.'; end if;
        if field.key not in ('title','created','problem','tools','agents','operation','results','difficulties','learning','collaboration','answer','observations','conclusions') then raise exception 'Campo de aportación desconocido: %',field.key; end if;
      end loop;
      select v,(ordinality-1)::integer into note,note_idx from jsonb_array_elements(s->'contributions') with ordinality as t(v,ordinality) where v->>'turnId'=turn->>'id' and v->>'authorId'=actor_text;
      note := jsonb_build_object('id',coalesce(note->>'id',gen_random_uuid()::text),'turnId',turn->>'id','authorId',actor_text,'fields',p_payload->'fields','updatedAt',now());
      if note_idx is null then s := jsonb_set(s,'{contributions}',(s->'contributions') || jsonb_build_array(note));
      else s := jsonb_set(s,'{contributions}',reflexia_private.replace_at(s->'contributions',note_idx,note)); end if;
    elsif p_type='finishTurn' then
      select v,(ordinality-1)::integer into turn,turn_idx from jsonb_array_elements(s->'turns') with ordinality as t(v,ordinality) where v->>'id'=p_payload->>'turnId' and v->>'teamId'=team->>'id';
      if turn is null then raise exception 'Turno no encontrado.'; end if;
      if turn->>'status'='finished' then
        insert into reflexia_private.requests(session_id,actor_id,request_id) values(p_session,actor,p_request);
        return s;
      end if;
      if team->>'currentTurnId'<>turn->>'id' or team->>'status'<>'recording' then raise exception 'Revela la carta antes de terminar el turno.'; end if;
      turn := jsonb_set(jsonb_set(turn,'{status}','"finished"'),'{finishedAt}',to_jsonb(now()));
      s := jsonb_set(s,'{turns}',reflexia_private.replace_at(s->'turns',turn_idx,turn));
      select count(*) into n from jsonb_array_elements(s->'turns')t where t->>'teamId'=team->>'id' and t->>'status'='finished';
      team := jsonb_set(jsonb_set(team,'{currentTurnId}','null'),'{status}',to_jsonb(case when n=jsonb_array_length(team->'memberIds') then 'finished' else 'ready' end));
      s := jsonb_set(s,'{teams}',reflexia_private.replace_at(s->'teams',team_idx,team));
      if not exists(select 1 from jsonb_array_elements(s->'teams')t where t->>'status'<>'finished') then
        s := jsonb_set(jsonb_set(jsonb_set(s,'{phase}','"finished"'),'{reportEnabled}','true'),'{finishedAt}',to_jsonb(now()));
      end if;
    end if;
  else raise exception 'Acción desconocida.';
  end if;
  s := jsonb_set(s,'{revision}',to_jsonb((s->>'revision')::integer+1));
  update reflexia_private.sessions set state=s where id=p_session;
  insert into reflexia_private.requests(session_id,actor_id,request_id) values(p_session,actor,p_request);
  return s;
end;
$$;

-- A scheduler must call this function. Merely installing it does not enable automatic deletion.
create function reflexia_private.purge_expired()
returns integer language plpgsql security definer set search_path = '' as $$
declare deleted integer;
begin
  delete from reflexia_private.sessions where expires_at<=now();
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on all functions in schema reflexia_private from public, anon, authenticated;
revoke all on function public.reflexia_join(uuid,text,text) from public, anon;
revoke all on function public.reflexia_state(uuid) from public, anon;
revoke all on function public.reflexia_action(uuid,text,jsonb,uuid) from public, anon;
grant execute on function public.reflexia_join(uuid,text,text) to authenticated;
grant execute on function public.reflexia_state(uuid) to authenticated;
grant execute on function public.reflexia_action(uuid,text,jsonb,uuid) to authenticated;
