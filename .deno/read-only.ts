import { Statement } from './syntax/ast.ts';
import { parse } from './parser.ts';
import { lexer } from './lexer.ts';

/**
 * Read-only inspection of parsed SQL statements.
 *
 * This module does not parse SQL by itself (except for the `checkReadOnly` convenience
 * entry point, which delegates to the regular parser) and never connects to a database
 * nor executes anything. It only walks the structure that the parser produced.
 *
 * The verdict is structural, not textual: a `SELECT 'delete from users'` is read-only,
 * because the operation words live inside a string literal, whereas a `WITH` binding
 * whose statement is a `DELETE` is not, because the parsed structure contains a write.
 */

/** Classification of a structural problem found in a statement. */
export type ReadOnlyIssueKind = 'write' | 'unsupported';

/** Classification of a single parsed statement. */
export type ReadOnlyStatementStatus = 'read-only' | 'write' | 'unsupported';

/** Classification of a whole inspection. */
export type ReadOnlyReportStatus = ReadOnlyStatementStatus | 'parse-error' | 'empty';

/**
 * A single structural finding.
 *
 * It deliberately holds no SQL text: only the kind of problem, the AST node type,
 * and its location inside the statement structure.
 */
export interface ReadOnlyIssue {
    kind: ReadOnlyIssueKind;
    /** AST node `type` at the reported location (e.g. `delete`). */
    nodeType: string;
    /**
     * Structural path from the statement root. `$` is the root statement itself,
     * `$.bind[0].statement` is the first CTE binding's statement, etc.
     */
    path: string;
    /**
     * Number of enclosing statements above the finding. `0` means the outermost
     * statement itself; a write inside the first CTE binding (`$.bind[0].statement`)
     * has depth `1`, which lets a reviewer tell it apart from the enclosing query
     * instead of blaming the query itself.
     */
    depth: number;
}

/** Verdict for one statement, at the position it had in the input. */
export interface ReadOnlyStatementResult {
    /** Position of this statement in the inspected input (0-based). */
    index: number;
    status: ReadOnlyStatementStatus;
    issues: ReadOnlyIssue[];
}

/** Result of a whole inspection. */
export interface ReadOnlyReport {
    status: ReadOnlyReportStatus;
    /**
     * `true` only when at least one statement was inspected and every statement is
     * read-only. Empty input, parse failures and any write/unsupported structure are
     * never considered passing.
     */
    readOnly: boolean;
    /** Per-statement verdicts, in the same order as the input. */
    statements: ReadOnlyStatementResult[];
}

function emptyReport(): ReadOnlyReport {
    return {
        status: 'empty',
        readOnly: false,
        statements: [],
    };
}

/**
 * Inspect already-parsed statements.
 *
 * This is the independent check entry point that works on parser results. The parser
 * API is left untouched; callers parse with `parse()` as usual and hand the result here.
 */
export function checkReadOnlyStatements(statements: Statement | readonly Statement[] | null | undefined): ReadOnlyReport {
    if (!statements) {
        return emptyReport();
    }
    const list: readonly Statement[] = Array.isArray(statements)
        ? statements
        : [statements];
    if (!list.length) {
        return emptyReport();
    }

    const results = list.map((statement, index) => analyzeStatement(statement, index));
    let hasWrite = false;
    let hasUnsupported = false;
    for (const result of results) {
        if (result.status === 'write') {
            hasWrite = true;
        } else if (result.status === 'unsupported') {
            hasUnsupported = true;
        }
    }
    // Writes are the most severe outcome, then structures needing review.
    const status: ReadOnlyReportStatus = hasWrite
        ? 'write'
        : hasUnsupported
            ? 'unsupported'
            : 'read-only';
    return {
        status,
        readOnly: status === 'read-only',
        statements: results,
    };
}

/**
 * Inspect SQL text using the repository's regular parser.
 *
 * Parse failures and empty input are reported separately and never pass:
 * they yield `parse-error` / `empty` respectively.
 */
export function checkReadOnly(sql: string): ReadOnlyReport {
    if (typeof sql !== 'string' || !sql.trim()) {
        return emptyReport();
    }
    if (hasNoStatement(sql)) {
        return emptyReport();
    }

    let statements: Statement[];
    try {
        statements = parse(sql);
    } catch {
        // Do not forward the parser message: it may quote the input.
        return {
            status: 'parse-error',
            readOnly: false,
            statements: [],
        };
    }
    if (!statements?.length) {
        return emptyReport();
    }
    return checkReadOnlyStatements(statements);
}

/**
 * True when the text only holds whitespace, statement separators and comments.
 * Such input carries no statement to inspect, so it is "empty" rather than a parse error.
 *
 * This uses the repository lexer (which already handles nested comments), so that the
 * classification does not depend on a regex approximation of SQL comments.
 */
function hasNoStatement(sql: string): boolean {
    try {
        lexer.reset(sql);
        let token = lexer.next();
        while (token) {
            if (token.type !== 'semicolon') {
                return false;
            }
            token = lexer.next();
        }
        return true;
    } catch {
        // If the lexer itself fails, let the parser produce the parse-error verdict.
        return false;
    }
}

// =============================================================================
// Structural walker
// =============================================================================

function record(issues: ReadOnlyIssue[], kind: ReadOnlyIssueKind, path: string, nodeType: string, depth: number): void {
    issues.push({ kind, path, nodeType, depth });
}

/** Statement `type` tags that perform a write. */
const WRITE_STATEMENT_TYPES = new Set<string>([
    'insert',
    'update',
    'delete',
    'truncate table',
]);

function isWriteStatementType(type: string): boolean {
    return WRITE_STATEMENT_TYPES.has(type);
}

function analyzeStatement(statement: Statement, index: number): ReadOnlyStatementResult {
    const issues: ReadOnlyIssue[] = [];
    visitStatement(statement as any, '$', 0, issues);

    let status: ReadOnlyStatementStatus = 'read-only';
    if (issues.some(i => i.kind === 'write')) {
        status = 'write';
    } else if (issues.length) {
        status = 'unsupported';
    }

    return { index, status, issues };
}

/**
 * @param depth Number of enclosing statements above this one: `0` at the outermost
 *              statement. Union branches are alternative trees of the same statement,
 *              so they keep the depth; nested statements (CTE bindings, `with ... in`,
 *              FROM sub-queries, scalar sub-queries) increase it.
 */
function visitStatement(value: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (!value || typeof value !== 'object') {
        record(issues, 'unsupported', path, 'missing', depth);
        return;
    }
    const type: string = typeof value.type === 'string' ? value.type : 'unknown';
    switch (type) {
        case 'select':
            visitSelect(value, path, depth, issues);
            return;
        case 'union':
        case 'union all':
            visitStatement(value.left, `${path}.left`, depth, issues);
            visitStatement(value.right, `${path}.right`, depth, issues);
            return;
        case 'values':
            visitValueRows(value.values, `${path}.values`, depth, issues);
            return;
        case 'with':
            visitWithBindings(value.bind, `${path}.bind`, depth, issues);
            visitStatement(value.in, `${path}.in`, depth + 1, issues);
            return;
        case 'with recursive':
            visitStatement(value.bind, `${path}.bind`, depth + 1, issues);
            visitStatement(value.in, `${path}.in`, depth + 1, issues);
            return;
        case 'insert':
        case 'update':
        case 'delete':
        case 'truncate table':
            // A write. No need to descend: the statement can no longer be read-only.
            record(issues, 'write', path, type, depth);
            return;
        default:
            // Any statement shape outside the supported scope needs manual review.
            record(issues, 'unsupported', path, type, depth);
            return;
    }
}

function visitValueRows(rows: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (rows == null) {
        return;
    }
    if (!Array.isArray(rows)) {
        record(issues, 'unsupported', path, 'values', depth);
        return;
    }
    rows.forEach((row: any, i: number) => {
        if (!Array.isArray(row)) {
            record(issues, 'unsupported', `${path}[${i}]`, 'values', depth);
            return;
        }
        row.forEach((expr: any, j: number) => visitExpr(expr, `${path}[${i}][${j}]`, depth, issues));
    });
}

function visitWithBindings(bindings: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (!Array.isArray(bindings)) {
        record(issues, 'unsupported', path, 'bind', depth);
        return;
    }
    bindings.forEach((binding: any, i: number) => {
        visitStatement(binding?.statement, `${path}[${i}].statement`, depth + 1, issues);
    });
}

function visitSelect(select: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (select.columns != null) {
        if (!Array.isArray(select.columns)) {
            record(issues, 'unsupported', `${path}.columns`, 'columns', depth);
        } else {
            select.columns.forEach((column: any, i: number) => {
                visitExpr(column?.expr, `${path}.columns[${i}].expr`, depth, issues);
            });
        }
    }

    if (select.from != null) {
        if (!Array.isArray(select.from)) {
            record(issues, 'unsupported', `${path}.from`, 'from', depth);
        } else {
            select.from.forEach((from: any, i: number) => visitFrom(from, `${path}.from[${i}]`, depth, issues));
        }
    }

    visitExpr(select.where, `${path}.where`, depth, issues);
    visitExprArray(select.groupBy, `${path}.groupBy`, depth, issues);
    visitExpr(select.having, `${path}.having`, depth, issues);
    visitOrderBy(select.orderBy, `${path}.orderBy`, depth, issues);

    if (select.limit != null) {
        visitExpr(select.limit.limit, `${path}.limit.limit`, depth, issues);
        visitExpr(select.limit.offset, `${path}.limit.offset`, depth, issues);
    }

    if (Array.isArray(select.distinct)) {
        visitExprArray(select.distinct, `${path}.distinct`, depth, issues);
    }

    if (select.for != null) {
        // Row-locking clauses need write-ish access in PostgreSQL, so a read-only
        // convention cannot certify them: send them to manual review.
        const lock = typeof select.for.type === 'string' ? select.for.type : 'unknown';
        record(issues, 'unsupported', `${path}.for`, `for:${lock}`, depth);
    }
}

function visitFrom(from: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (!from || typeof from !== 'object') {
        record(issues, 'unsupported', path, 'missing', depth);
        return;
    }
    switch (from.type) {
        case 'table':
            break;
        case 'statement':
            // A FROM sub-query is a nested statement.
            visitStatement(from.statement, `${path}.statement`, depth + 1, issues);
            break;
        case 'call':
            visitExpr(from, path, depth, issues);
            break;
        default:
            record(issues, 'unsupported', path, typeof from.type === 'string' ? from.type : 'unknown', depth);
            return;
    }
    if (from.join?.on != null) {
        visitExpr(from.join.on, `${path}.join.on`, depth, issues);
    }
}

function visitExprArray(value: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (value == null) {
        return;
    }
    if (!Array.isArray(value)) {
        record(issues, 'unsupported', path, 'expression-list', depth);
        return;
    }
    value.forEach((expr: any, i: number) => visitExpr(expr, `${path}[${i}]`, depth, issues));
}

function visitOrderBy(value: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (value == null) {
        return;
    }
    if (!Array.isArray(value)) {
        record(issues, 'unsupported', path, 'order-by', depth);
        return;
    }
    value.forEach((item: any, i: number) => visitExpr(item?.by, `${path}[${i}].by`, depth, issues));
}

function visitExpr(value: any, path: string, depth: number, issues: ReadOnlyIssue[]): void {
    if (value == null) {
        return;
    }
    if (typeof value !== 'object') {
        record(issues, 'unsupported', path, 'missing', depth);
        return;
    }
    const type: string = typeof value.type === 'string' ? value.type : 'unknown';
    switch (type) {
        case 'select':
        case 'union':
        case 'union all':
        case 'values':
        case 'with':
        case 'with recursive':
            // Scalar sub-queries are statements nested in an expression.
            visitStatement(value, path, depth + 1, issues);
            return;
        case 'array select':
            visitStatement(value.select, `${path}.select`, depth + 1, issues);
            return;
        case 'binary':
            visitExpr(value.left, `${path}.left`, depth, issues);
            visitExpr(value.right, `${path}.right`, depth, issues);
            return;
        case 'unary':
            visitExpr(value.operand, `${path}.operand`, depth, issues);
            return;
        case 'ternary':
            visitExpr(value.value, `${path}.value`, depth, issues);
            visitExpr(value.lo, `${path}.lo`, depth, issues);
            visitExpr(value.hi, `${path}.hi`, depth, issues);
            return;
        case 'cast':
            visitExpr(value.operand, `${path}.operand`, depth, issues);
            return;
        case 'case':
            visitExpr(value.value, `${path}.value`, depth, issues);
            if (Array.isArray(value.whens)) {
                value.whens.forEach((when: any, i: number) => {
                    visitExpr(when?.when, `${path}.whens[${i}].when`, depth, issues);
                    visitExpr(when?.value, `${path}.whens[${i}].value`, depth, issues);
                });
            }
            visitExpr(value.else, `${path}.else`, depth, issues);
            return;
        case 'member':
            visitExpr(value.operand, `${path}.operand`, depth, issues);
            return;
        case 'arrayIndex':
            visitExpr(value.array, `${path}.array`, depth, issues);
            visitExpr(value.index, `${path}.index`, depth, issues);
            return;
        case 'extract':
            visitExpr(value.from, `${path}.from`, depth, issues);
            return;
        case 'list':
        case 'array':
            visitExprArray(value.expressions, `${path}.expressions`, depth, issues);
            return;
        case 'call':
            visitExprArray(value.args, `${path}.args`, depth, issues);
            visitExpr(value.filter, `${path}.filter`, depth, issues);
            visitOrderBy(value.orderBy, `${path}.orderBy`, depth, issues);
            if (value.withinGroup != null) {
                visitExpr(value.withinGroup.by, `${path}.withinGroup.by`, depth, issues);
            }
            if (value.over != null) {
                visitExprArray(value.over.partitionBy, `${path}.over.partitionBy`, depth, issues);
                visitOrderBy(value.over.orderBy, `${path}.over.orderBy`, depth, issues);
            }
            return;
        case 'overlay':
            visitExpr(value.value, `${path}.value`, depth, issues);
            visitExpr(value.placing, `${path}.placing`, depth, issues);
            visitExpr(value.from, `${path}.from`, depth, issues);
            visitExpr(value.for, `${path}.for`, depth, issues);
            return;
        case 'substring':
            visitExpr(value.value, `${path}.value`, depth, issues);
            visitExpr(value.from, `${path}.from`, depth, issues);
            visitExpr(value.for, `${path}.for`, depth, issues);
            return;
        case 'ref':
        case 'parameter':
        case 'integer':
        case 'numeric':
        case 'string':
        case 'boolean':
        case 'null':
        case 'constant':
        case 'default':
        case 'keyword':
            // Leaves: cannot contain a nested statement.
            return;
        default:
            if (isWriteStatementType(type)) {
                // A write placed in an expression slot cannot come from a supported
                // query, but a hand-built structure may contain one: report it as a
                // nested write statement.
                record(issues, 'write', path, type, depth + 1);
                return;
            }
            // Unrecognized expression shapes also need manual review.
            record(issues, 'unsupported', path, type, depth);
            return;
    }
}
