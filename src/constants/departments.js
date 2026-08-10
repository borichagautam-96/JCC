// The department codes cost is booked against.
//
// Shared deliberately. This list previously lived only in JobCreationPage, where the
// second code was typed as 3988 while the real one is 3998 — and because the voucher
// form hardcoded 3559 instead of offering a choice, nothing ever compared the two and
// the wrong code sat on the printing request form unnoticed.
//
// Anything that offers a department code should import this rather than restate it.
export const DEPARTMENT_CODES = ['3559', '3998'];

export const isValidDepartmentCode = (code) =>
  DEPARTMENT_CODES.includes(String(code ?? '').trim());
