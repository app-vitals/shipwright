import { defineCollection, z } from "astro:content";

const docs = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    section: z.string(),
    order: z.number(),
    prev: z.string().optional(),
    next: z.string().optional(),
  }),
});

export const collections = { docs };
