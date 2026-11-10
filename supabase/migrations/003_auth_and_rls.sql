-- repo_story_jobs RLS policies
create policy "Users can view their own jobs"
  on public.repo_story_jobs
  for select
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

create policy "Users can insert their own jobs"
  on public.repo_story_jobs
  for insert
  with check (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

create policy "Users can update their own jobs"
  on public.repo_story_jobs
  for update
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

-- repo_story_results RLS policies
create policy "Users can view their own results"
  on public.repo_story_results
  for select
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

create policy "Users can insert and update their own results"
  on public.repo_story_results
  for all
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

-- repo_story_diagrams RLS policies
create policy "Users can view their own diagrams"
  on public.repo_story_diagrams
  for select
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

create policy "Users can manage their own diagrams"
  on public.repo_story_diagrams
  for all
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

-- repo_story_explanations RLS policies
create policy "Users can view their own explanations"
  on public.repo_story_explanations
  for select
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );

create policy "Users can manage their own explanations"
  on public.repo_story_explanations
  for all
  using (
    owner_id = auth.uid()::text 
    or owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')
  );