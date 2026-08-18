ALTER TYPE "public"."conversation_stage" ADD VALUE 'screening_exclusivity' BEFORE 'qualified';--> statement-breakpoint
ALTER TYPE "public"."conversation_stage" ADD VALUE 'blocked' BEFORE 'error';