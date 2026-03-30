import { z } from 'zod';

const emptyObject = z.object({}).passthrough();

const idParamSchema = z.object({
    id: z.string().regex(/^\d+$/, 'Invoice id must be a number'),
});

const amountSchema = z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => {
        if (value === undefined || value === null) return undefined;
        const normalized = String(value).trim();
        return normalized || undefined;
    });

export const uploadInvoiceSchema = z.object({
    body: z.object({
        vendorName: z.string().trim().max(255).optional(),
        amount: amountSchema,
        invoiceNumber: z.string().trim().max(120).optional(),
        invoiceDate: z.string().trim().max(40).optional(),
        assignedTo: z.string().trim().min(1, 'assignedTo is required').max(120),
        poNumber: z.string().trim().max(120).optional(),
    }),
    query: emptyObject,
    params: emptyObject,
});

export const assignedInvoicesSchema = z.object({
    body: emptyObject,
    query: z.object({
        scope: z.enum(['assigned', 'dashboard']).optional(),
    }).passthrough(),
    params: emptyObject,
});

export const invoiceIdSchema = z.object({
    body: emptyObject,
    query: emptyObject,
    params: idParamSchema,
});
