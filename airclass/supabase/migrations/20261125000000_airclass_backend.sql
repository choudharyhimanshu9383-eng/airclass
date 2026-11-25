create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('teacher', 'student')),
  created_at timestamptz not null default now()
);

create table public.classrooms (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table public.class_members (
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  joined_at timestamptz not null default now(),
  primary key (classroom_id, user_id)
);

create table public.lesson_materials (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id),
  file_name text not null,
  file_type text not null check (file_type in ('pdf', 'pptx')),
  storage_path text not null unique,
  quiz_questions jsonb not null default '[]'::jsonb,
  page_count integer not null default 0 check (page_count >= 0),
  slide_count integer not null default 0 check (slide_count >= 0),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table public.quiz_submissions (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  material_id uuid not null references public.lesson_materials (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (student_id, material_id)
);

create table public.activity_results (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  profile text not null,
  mode text not null,
  test text not null,
  value text not null,
  created_at timestamptz not null default now()
);

create index class_members_user_idx on public.class_members (user_id);
create index lesson_materials_class_created_idx
  on public.lesson_materials (classroom_id, created_at desc);
create index quiz_submissions_class_idx
  on public.quiz_submissions (classroom_id, updated_at desc);
create index activity_results_class_created_idx
  on public.activity_results (classroom_id, created_at desc);

create function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_role text := new.raw_user_meta_data ->> 'role';
  requested_name text := btrim(new.raw_user_meta_data ->> 'display_name');
begin
  if requested_role not in ('teacher', 'student') then
    raise exception 'Choose a teacher or student account.';
  end if;
  if requested_name is null or char_length(requested_name) not between 1 and 80 then
    raise exception 'Name must be between 1 and 80 characters.';
  end if;

  insert into public.profiles (id, display_name, role)
  values (new.id, requested_name, requested_role);
  return new;
end;
$$;

create trigger on_auth_user_created_airclass
after insert on auth.users
for each row execute procedure public.create_profile_for_new_user();

create function public.is_class_member(target_class_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.class_members member
    where member.classroom_id = target_class_id
      and member.user_id = target_user_id
  );
$$;

create function public.is_class_teacher(target_class_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.classrooms classroom
    where classroom.id = target_class_id
      and classroom.teacher_id = target_user_id
  );
$$;

create function public.is_class_student(target_class_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.class_members member
    where member.classroom_id = target_class_id
      and member.user_id = target_user_id
      and member.role = 'student'
  );
$$;

create function public.create_class_for_teacher(p_class_name text)
returns table (id uuid, name text, invite_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_role text;
  new_class_id uuid;
  new_invite_code text;
  clean_name text := btrim(p_class_name);
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a class.';
  end if;
  select profile.role into current_role
  from public.profiles profile
  where profile.id = auth.uid();
  if current_role <> 'teacher' then
    raise exception 'Only teacher accounts can create a class.';
  end if;
  if clean_name is null or char_length(clean_name) not between 1 and 80 then
    raise exception 'Class name must be between 1 and 80 characters.';
  end if;

  loop
    new_invite_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
    begin
      insert into public.classrooms (teacher_id, name, invite_code)
      values (auth.uid(), clean_name, new_invite_code)
      returning classrooms.id into new_class_id;
      exit;
    exception when unique_violation then
      new_class_id := null;
    end;
  end loop;

  insert into public.class_members (classroom_id, user_id, role)
  values (new_class_id, auth.uid(), 'teacher');

  return query
  select classroom.id, classroom.name, classroom.invite_code
  from public.classrooms classroom
  where classroom.id = new_class_id;
end;
$$;

create function public.join_class_with_code(p_invite_code text)
returns table (id uuid, name text, invite_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_role text;
  target_class public.classrooms%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining a class.';
  end if;
  select profile.role into current_role
  from public.profiles profile
  where profile.id = auth.uid();
  if current_role <> 'student' then
    raise exception 'Only student accounts can join with an invite code.';
  end if;

  select classroom.* into target_class
  from public.classrooms classroom
  where lower(classroom.invite_code) = lower(btrim(p_invite_code))
  limit 1;
  if target_class.id is null then
    raise exception 'That class invite code was not found.';
  end if;

  insert into public.class_members (classroom_id, user_id, role)
  values (target_class.id, auth.uid(), 'student')
  on conflict (classroom_id, user_id) do nothing;

  return query
  select target_class.id, target_class.name, target_class.invite_code;
end;
$$;

revoke all on function public.create_class_for_teacher(text) from public;
revoke all on function public.join_class_with_code(text) from public;
revoke all on function public.is_class_member(uuid, uuid) from public;
revoke all on function public.is_class_teacher(uuid, uuid) from public;
revoke all on function public.is_class_student(uuid, uuid) from public;
grant execute on function public.create_class_for_teacher(text) to authenticated;
grant execute on function public.join_class_with_code(text) to authenticated;
grant execute on function public.is_class_member(uuid, uuid) to authenticated;
grant execute on function public.is_class_teacher(uuid, uuid) to authenticated;
grant execute on function public.is_class_student(uuid, uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.classrooms enable row level security;
alter table public.class_members enable row level security;
alter table public.lesson_materials enable row level security;
alter table public.quiz_submissions enable row level security;
alter table public.activity_results enable row level security;

create policy "Users can read their own profile"
on public.profiles for select to authenticated
using (id = auth.uid());

create policy "Users can update their own display name"
on public.profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "Class members can read their classroom"
on public.classrooms for select to authenticated
using (public.is_class_member(id));

create policy "Members can read their own membership"
on public.class_members for select to authenticated
using (user_id = auth.uid() or public.is_class_teacher(classroom_id));

create policy "Class members can read lesson materials"
on public.lesson_materials for select to authenticated
using (public.is_class_member(classroom_id));

create policy "Class teachers can add lesson materials"
on public.lesson_materials for insert to authenticated
with check (
  uploaded_by = auth.uid()
  and public.is_class_teacher(classroom_id)
);

create policy "Class teachers can update lesson materials"
on public.lesson_materials for update to authenticated
using (public.is_class_teacher(classroom_id))
with check (uploaded_by = auth.uid() and public.is_class_teacher(classroom_id));

create policy "Class teachers can delete lesson materials"
on public.lesson_materials for delete to authenticated
using (public.is_class_teacher(classroom_id));

create policy "Students and class teachers can read quiz submissions"
on public.quiz_submissions for select to authenticated
using (
  student_id = auth.uid()
  or public.is_class_teacher(classroom_id)
);

create policy "Students can save their own quiz submissions"
on public.quiz_submissions for insert to authenticated
with check (
  student_id = auth.uid()
  and public.is_class_student(classroom_id)
  and exists (
    select 1
    from public.lesson_materials material
    where material.id = material_id
      and material.classroom_id = classroom_id
  )
);

create policy "Students can update their own quiz submissions"
on public.quiz_submissions for update to authenticated
using (student_id = auth.uid() and public.is_class_student(classroom_id))
with check (student_id = auth.uid() and public.is_class_student(classroom_id));

create policy "Class members can read activity results"
on public.activity_results for select to authenticated
using (
  user_id = auth.uid()
  or public.is_class_teacher(classroom_id)
);

create policy "Class members can create their own activity results"
on public.activity_results for insert to authenticated
with check (
  user_id = auth.uid()
  and public.is_class_member(classroom_id)
);

create policy "Users and class teachers can delete activity results"
on public.activity_results for delete to authenticated
using (
  user_id = auth.uid()
  or public.is_class_teacher(classroom_id)
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lesson-files',
  'lesson-files',
  false,
  52428800,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Class members can read stored lesson files"
on storage.objects for select to authenticated
using (
  bucket_id = 'lesson-files'
  and exists (
    select 1
    from public.classrooms classroom
    where classroom.id::text = split_part(name, '/', 1)
      and public.is_class_member(classroom.id)
  )
);

create policy "Class teachers can upload lesson files"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'lesson-files'
  and exists (
    select 1
    from public.classrooms classroom
    where classroom.id::text = split_part(name, '/', 1)
      and public.is_class_teacher(classroom.id)
  )
);

create policy "Class teachers can update lesson files"
on storage.objects for update to authenticated
using (
  bucket_id = 'lesson-files'
  and exists (
    select 1
    from public.classrooms classroom
    where classroom.id::text = split_part(name, '/', 1)
      and public.is_class_teacher(classroom.id)
  )
)
with check (
  bucket_id = 'lesson-files'
  and exists (
    select 1
    from public.classrooms classroom
    where classroom.id::text = split_part(name, '/', 1)
      and public.is_class_teacher(classroom.id)
  )
);

create policy "Class teachers can delete lesson files"
on storage.objects for delete to authenticated
using (
  bucket_id = 'lesson-files'
  and exists (
    select 1
    from public.classrooms classroom
    where classroom.id::text = split_part(name, '/', 1)
      and public.is_class_teacher(classroom.id)
  )
);
