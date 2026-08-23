CREATE VIEW "public"."leads" AS (
  SELECT
    conv.id                                        AS conversation_id,
    c.phone,
    c.name,
    c.entry_point,
    conv.stage,
    conv.qualified,
    conv.priority_score,
    conv.disqualification_reason,
    conv.extracted ->> 'sellIntent'                AS sell_intent,
    conv.extracted ->> 'neighborhood'              AS neighborhood,
    conv.extracted ->> 'timeline'                  AS timeline,
    conv.extracted ->> 'currentlyMarketed'         AS currently_marketed,
    conv.extracted ->> 'seriousSeller'             AS serious_seller,
    conv.extracted ->> 'sellMotivation'            AS sell_motivation,
    conv.extracted ->> 'additionalNotes'           AS additional_notes,
    conv.extracted ->> 'exclusivityEndsAt'         AS exclusivity_ends_at,
    conv.extracted ->> 'wantsExclusivityFollowup'  AS wants_exclusivity_followup,
    conv.created_at,
    conv.updated_at
  FROM conversations conv
  JOIN contacts c ON c.id = conv.contact_id
);