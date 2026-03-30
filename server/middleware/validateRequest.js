export const validateRequest = (schema) => {
    return (req, res, next) => {
        const result = schema.safeParse({
            body: req.body,
            query: req.query,
            params: req.params,
        });

        if (!result.success) {
            const details = result.error.issues.map((issue) => ({
                field: issue.path.join('.'),
                message: issue.message,
            }));

            return res.status(400).json({
                error: 'Validation failed',
                details,
            });
        }

        req.body = result.data.body;
        req.query = result.data.query;
        req.params = result.data.params;
        next();
    };
};
