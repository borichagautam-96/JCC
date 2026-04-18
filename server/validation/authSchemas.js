import { z } from 'zod';

const emptyObject = z.object({}).passthrough();

const optionalTrimmedString = z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional();

const requiredPassword = z.string().min(1, 'Password is required');

export const registerSchema = z.object({
    body: z.object({
        name: z.string().trim().min(1, 'Name is required').max(120),
        email: z.string().trim().email('Valid email is required').max(255),
        password: z.string().min(6, 'Password must be at least 6 characters').max(128),
        role: z.string().trim().min(1).max(50).optional(),
    }),
    query: emptyObject,
    params: emptyObject,
});

export const loginSchema = z.object({
    body: z
        .object({
            identifier: optionalTrimmedString,
            psNumber: optionalTrimmedString,
            ps_number: optionalTrimmedString,
            password: requiredPassword,
        })
        .superRefine((value, ctx) => {
            if (!value.identifier && !value.psNumber && !value.ps_number) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: 'Username or PS Number is required',
                    path: ['identifier'],
                });
            }
        }),
    query: emptyObject,
    params: emptyObject,
});
