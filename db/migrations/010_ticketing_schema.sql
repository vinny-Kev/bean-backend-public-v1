-- Ticketing schema (tickets, assignments, comments, activity, inboxes, story points, work
-- verifications). These tables were created out-of-band in the development database and only
-- exist in db/schema/baseline.sql; this migration gives every other database the same schema.
--
-- Generated from baseline.sql (the pg_dump of the development database) and made idempotent:
-- CREATE ... IF NOT EXISTS, and each constraint is added only when its name is missing. On a
-- database that already has the tables (the baseline, or the development database) it changes
-- nothing. Requires PostgreSQL 15+ (ON DELETE SET NULL (column) list), as the baseline does.
-- Prerequisites: tenants and users tables.

CREATE TABLE IF NOT EXISTS public.ticket_activity (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    actor_user_id bigint,
    activity_type character varying(50) NOT NULL,
    field_name character varying(100),
    old_value jsonb,
    new_value jsonb,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ticket_assignments (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    user_id bigint NOT NULL,
    assigned_by_user_id bigint,
    is_primary boolean DEFAULT false NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    unassigned_at timestamp with time zone,
    notes text,
    CONSTRAINT ticket_assignments_check CHECK (((unassigned_at IS NULL) OR (unassigned_at >= assigned_at)))
);

CREATE TABLE IF NOT EXISTS public.ticket_comments (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    author_user_id bigint,
    body text NOT NULL,
    is_internal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT ticket_comments_body_check CHECK ((length(TRIM(BOTH FROM body)) > 0))
);

CREATE TABLE IF NOT EXISTS public.ticket_inboxes (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    name character varying(150) NOT NULL,
    email character varying(320) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by_user_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ticket_story_points (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    estimated_points numeric(6,2) DEFAULT 0 NOT NULL,
    estimated_by_user_id bigint,
    estimate_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_story_points_estimated_points_check CHECK ((estimated_points >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.ticket_work_verifications (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    contributor_user_id bigint NOT NULL,
    verified_points numeric(6,2) NOT NULL,
    verified_by_user_id bigint NOT NULL,
    verification_status character varying(20) DEFAULT 'verified'::character varying NOT NULL,
    verification_notes text,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by_user_id bigint,
    CONSTRAINT ticket_work_verifications_check CHECK (((((verification_status)::text = 'verified'::text) AND (revoked_at IS NULL)) OR (((verification_status)::text = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT ticket_work_verifications_verification_status_check CHECK (((verification_status)::text = ANY ((ARRAY['verified'::character varying, 'revoked'::character varying])::text[]))),
    CONSTRAINT ticket_work_verifications_verified_points_check CHECK ((verified_points >= (0)::numeric))
);

CREATE TABLE IF NOT EXISTS public.tickets (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    tenant_id bigint NOT NULL,
    ticket_number bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    title character varying(250) NOT NULL,
    description text,
    ticket_type character varying(30) DEFAULT 'support'::character varying NOT NULL,
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    requester_user_id bigint,
    inbox_id bigint,
    assigned_to_user_id bigint,
    created_by_user_id bigint,
    parent_ticket_id bigint,
    due_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tickets_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]))),
    CONSTRAINT tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'acknowledged'::character varying, 'in_progress'::character varying, 'pending'::character varying, 'resolved'::character varying, 'closed'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT tickets_ticket_type_check CHECK (((ticket_type)::text = ANY ((ARRAY['support'::character varying, 'task'::character varying, 'hr_task'::character varying, 'bug'::character varying, 'incident'::character varying])::text[])))
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_activity_pkey' AND conrelid = 'public.ticket_activity'::regclass) THEN
        ALTER TABLE ONLY public.ticket_activity ADD CONSTRAINT ticket_activity_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_assignments_pkey' AND conrelid = 'public.ticket_assignments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_assignments ADD CONSTRAINT ticket_assignments_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_pkey' AND conrelid = 'public.ticket_comments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_comments ADD CONSTRAINT ticket_comments_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_inboxes_pkey' AND conrelid = 'public.ticket_inboxes'::regclass) THEN
        ALTER TABLE ONLY public.ticket_inboxes ADD CONSTRAINT ticket_inboxes_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_inboxes_tenant_id_email_key' AND conrelid = 'public.ticket_inboxes'::regclass) THEN
        ALTER TABLE ONLY public.ticket_inboxes ADD CONSTRAINT ticket_inboxes_tenant_id_email_key UNIQUE (tenant_id, email);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_inboxes_tenant_id_id_key' AND conrelid = 'public.ticket_inboxes'::regclass) THEN
        ALTER TABLE ONLY public.ticket_inboxes ADD CONSTRAINT ticket_inboxes_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_story_points_pkey' AND conrelid = 'public.ticket_story_points'::regclass) THEN
        ALTER TABLE ONLY public.ticket_story_points ADD CONSTRAINT ticket_story_points_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_story_points_ticket_id_key' AND conrelid = 'public.ticket_story_points'::regclass) THEN
        ALTER TABLE ONLY public.ticket_story_points ADD CONSTRAINT ticket_story_points_ticket_id_key UNIQUE (ticket_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_verifications_pkey' AND conrelid = 'public.ticket_work_verifications'::regclass) THEN
        ALTER TABLE ONLY public.ticket_work_verifications ADD CONSTRAINT ticket_work_verifications_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_pkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tenant_id_id_key' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tenant_id_ticket_number_key' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_tenant_id_ticket_number_key UNIQUE (tenant_id, ticket_number);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ticket_activity_ticket_created ON public.ticket_activity USING btree (tenant_id, ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_assignments_user_active ON public.ticket_assignments USING btree (tenant_id, user_id, assigned_at DESC) WHERE (unassigned_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_created ON public.ticket_comments USING btree (tenant_id, ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_inboxes_tenant_active ON public.ticket_inboxes USING btree (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ticket_verifications_employee_date ON public.ticket_work_verifications USING btree (tenant_id, contributor_user_id, verified_at DESC) WHERE ((verification_status)::text = 'verified'::text);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_assignee_status ON public.tickets USING btree (tenant_id, assigned_to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_due ON public.tickets USING btree (tenant_id, due_at) WHERE (due_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_requester ON public.tickets USING btree (tenant_id, requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status_created ON public.tickets USING btree (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_active_assignment ON public.ticket_assignments USING btree (ticket_id, user_id) WHERE (unassigned_at IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_primary_assignment ON public.ticket_assignments USING btree (ticket_id) WHERE ((is_primary = true) AND (unassigned_at IS NULL));

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_activity_actor_user_id_fkey' AND conrelid = 'public.ticket_activity'::regclass) THEN
        ALTER TABLE ONLY public.ticket_activity ADD CONSTRAINT ticket_activity_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_activity_tenant_id_ticket_id_fkey' AND conrelid = 'public.ticket_activity'::regclass) THEN
        ALTER TABLE ONLY public.ticket_activity ADD CONSTRAINT ticket_activity_tenant_id_ticket_id_fkey FOREIGN KEY (tenant_id, ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_assignments_assigned_by_user_id_fkey' AND conrelid = 'public.ticket_assignments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_assignments ADD CONSTRAINT ticket_assignments_assigned_by_user_id_fkey FOREIGN KEY (assigned_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_assignments_tenant_id_ticket_id_fkey' AND conrelid = 'public.ticket_assignments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_assignments ADD CONSTRAINT ticket_assignments_tenant_id_ticket_id_fkey FOREIGN KEY (tenant_id, ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_assignments_user_id_fkey' AND conrelid = 'public.ticket_assignments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_assignments ADD CONSTRAINT ticket_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_author_user_id_fkey' AND conrelid = 'public.ticket_comments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_comments ADD CONSTRAINT ticket_comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_comments_tenant_id_ticket_id_fkey' AND conrelid = 'public.ticket_comments'::regclass) THEN
        ALTER TABLE ONLY public.ticket_comments ADD CONSTRAINT ticket_comments_tenant_id_ticket_id_fkey FOREIGN KEY (tenant_id, ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_inboxes_created_by_user_id_fkey' AND conrelid = 'public.ticket_inboxes'::regclass) THEN
        ALTER TABLE ONLY public.ticket_inboxes ADD CONSTRAINT ticket_inboxes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_inboxes_tenant_id_fkey' AND conrelid = 'public.ticket_inboxes'::regclass) THEN
        ALTER TABLE ONLY public.ticket_inboxes ADD CONSTRAINT ticket_inboxes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_story_points_estimated_by_user_id_fkey' AND conrelid = 'public.ticket_story_points'::regclass) THEN
        ALTER TABLE ONLY public.ticket_story_points ADD CONSTRAINT ticket_story_points_estimated_by_user_id_fkey FOREIGN KEY (estimated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_story_points_tenant_id_ticket_id_fkey' AND conrelid = 'public.ticket_story_points'::regclass) THEN
        ALTER TABLE ONLY public.ticket_story_points ADD CONSTRAINT ticket_story_points_tenant_id_ticket_id_fkey FOREIGN KEY (tenant_id, ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_verifications_contributor_user_id_fkey' AND conrelid = 'public.ticket_work_verifications'::regclass) THEN
        ALTER TABLE ONLY public.ticket_work_verifications ADD CONSTRAINT ticket_work_verifications_contributor_user_id_fkey FOREIGN KEY (contributor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_verifications_revoked_by_user_id_fkey' AND conrelid = 'public.ticket_work_verifications'::regclass) THEN
        ALTER TABLE ONLY public.ticket_work_verifications ADD CONSTRAINT ticket_work_verifications_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_verifications_tenant_id_ticket_id_fkey' AND conrelid = 'public.ticket_work_verifications'::regclass) THEN
        ALTER TABLE ONLY public.ticket_work_verifications ADD CONSTRAINT ticket_work_verifications_tenant_id_ticket_id_fkey FOREIGN KEY (tenant_id, ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_work_verifications_verified_by_user_id_fkey' AND conrelid = 'public.ticket_work_verifications'::regclass) THEN
        ALTER TABLE ONLY public.ticket_work_verifications ADD CONSTRAINT ticket_work_verifications_verified_by_user_id_fkey FOREIGN KEY (verified_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_assigned_to_user_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_created_by_user_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_requester_user_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tenant_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tenant_id_inbox_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_tenant_id_inbox_id_fkey FOREIGN KEY (tenant_id, inbox_id) REFERENCES public.ticket_inboxes(tenant_id, id) ON DELETE SET NULL (inbox_id);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tickets_tenant_id_parent_ticket_id_fkey' AND conrelid = 'public.tickets'::regclass) THEN
        ALTER TABLE ONLY public.tickets ADD CONSTRAINT tickets_tenant_id_parent_ticket_id_fkey FOREIGN KEY (tenant_id, parent_ticket_id) REFERENCES public.tickets(tenant_id, id) ON DELETE SET NULL (parent_ticket_id);
    END IF;
END $$;
