create schema if not exists pgmq;
create schema if not exists cron;
create schema if not exists net;
create schema if not exists vault;

create table pgmq.messages(
  msg_id bigint generated always as identity primary key,
  queue_name text not null,
  message jsonb not null,
  visible_at timestamptz not null default now(),
  read_count integer not null default 0
);
create function pgmq.create(queue_name text) returns void language plpgsql as $$begin return; end$$;
create function pgmq.send(queue_name text,message jsonb) returns bigint language plpgsql as $$
declare result bigint; begin
  insert into pgmq.messages(queue_name,message) values(queue_name,message) returning msg_id into result;
  return result;
end$$;
create function pgmq.send(queue_name text,message jsonb,sleep_seconds integer) returns bigint language plpgsql as $$
declare result bigint; begin
  insert into pgmq.messages(queue_name,message,visible_at) values(queue_name,message,now()+make_interval(secs=>greatest(sleep_seconds,0))) returning msg_id into result;
  return result;
end$$;
create function pgmq.read(queue_name text,visibility_timeout integer,qty integer) returns table(msg_id bigint,message jsonb) language plpgsql as $$
begin
  return query
  with claimed as (
    select m.msg_id from pgmq.messages m
    where m.queue_name=$1 and m.visible_at<=now()
    order by m.msg_id for update skip locked limit greatest($3,0)
  ), updated as (
    update pgmq.messages m set visible_at=now()+make_interval(secs=>greatest($2,0)),read_count=read_count+1
    from claimed where m.msg_id=claimed.msg_id
    returning m.msg_id,m.message
  ) select updated.msg_id,updated.message from updated;
end$$;
create function pgmq.delete(queue_name text,msg_id bigint) returns boolean language plpgsql as $$declare affected integer; begin delete from pgmq.messages m where m.queue_name=$1 and m.msg_id=$2; get diagnostics affected=row_count; return affected>0; end$$;

create table cron.job(jobid bigint generated always as identity primary key,jobname text unique not null,schedule text,command text,active boolean not null default true);
create function cron.schedule(job_name text,schedule text,command text) returns bigint language plpgsql as $$declare result bigint; begin insert into cron.job(jobname,schedule,command) values(job_name,schedule,command) returning jobid into result; return result; end$$;
create function cron.unschedule(target_jobid bigint) returns boolean language plpgsql as $$begin delete from cron.job where jobid=target_jobid; return found; end$$;

create table vault.decrypted_secrets(name text primary key,decrypted_secret text);
create function net.http_post(url text,headers jsonb default '{}'::jsonb,body jsonb default '{}'::jsonb,timeout_milliseconds integer default 1000) returns bigint language sql as $$select 1::bigint$$;
