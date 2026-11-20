import 'mocha';
import { expect } from 'chai';
import { parse } from './parser';
import { checkReadOnly, checkReadOnlyStatements } from './read-only';
import { Statement, DeleteStatement, SelectFromStatement, UpdateStatement, WithStatement } from './syntax/ast';

function expectNoSqlText(report: unknown, sql: string) {
    const serialized = JSON.stringify(report);
    expect(serialized).not.to.contain(sql.trim());
    // Report objects must only expose structural information.
    expect(serialized).not.to.match(/\bselect \*/i);
}

describe('Read-only inspection', () => {

    it('accepts a parameterized query parsed by the regular parser', () => {
        const sql = 'select id, name from users where id = $1';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('read-only');
        expect(report.readOnly).to.equal(true);
        expect(report.statements).to.have.length(1);
        expect(report.statements[0].status).to.equal('read-only');
        expect(report.statements[0].issues).to.deep.equal([]);

        // The existing parser API keeps its parameter support.
        const ast = parse(sql);
        expect(ast).to.have.length(1);
        const where = (ast[0] as SelectFromStatement).where as any;
        expect(where.type).to.equal('binary');
        expect(where.right).to.deep.include({ type: 'parameter', name: '$1' });
    });

    it('accepts a read-only common table expression', () => {
        const sql = 'with visible as (select id from users where active = true) select id from visible';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('read-only');
        expect(report.readOnly).to.equal(true);
        expect(report.statements[0].issues).to.deep.equal([]);
    });

    it('accepts quoted identifiers and ignores operation words inside literals', () => {
        const sql = `select "update" from "delete" where note = 'insert into users'`;
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('read-only');
        expect(report.readOnly).to.equal(true);
    });

    it('rejects an ordinary insert', () => {
        const sql = 'insert into audit_log (action) values ($1)';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('write');
        expect(report.readOnly).to.equal(false);
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$', nodeType: 'insert', depth: 0 },
        ]);
    });

    it('rejects an ordinary update', () => {
        const sql = 'update accounts set balance = balance + 1 where id = $1';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('write');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$', nodeType: 'update', depth: 0 },
        ]);
    });

    it('rejects an ordinary delete', () => {
        const sql = 'delete from sessions where expired = true';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('write');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$', nodeType: 'delete', depth: 0 },
        ]);
    });

    it('rejects a data-modifying CTE and points at the binding level', () => {
        const sql = 'with purged as (delete from stale_rows) select * from purged';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('write');
        expect(report.readOnly).to.equal(false);
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$.bind[0].statement', nodeType: 'delete', depth: 1 },
        ]);
    });

    it('locates a write nested several structural levels down', () => {
        // Synthesized structure: with -> binding -> with -> in -> update.
        const update: UpdateStatement = {
            type: 'update',
            table: { name: 'accounts' },
            sets: [{ column: { name: 'balance' }, value: { type: 'integer', value: 1 } }],
        };
        const inner: WithStatement = {
            type: 'with',
            bind: [{ alias: { name: 'x' }, statement: { type: 'select' } }],
            in: update,
        };
        const outer: WithStatement = {
            type: 'with',
            bind: [{
                alias: { name: 'outer' },
                statement: inner,
            }],
            in: { type: 'select' },
        };
        const report = checkReadOnlyStatements([outer]);
        expect(report.status).to.equal('write');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$.bind[0].statement.in', nodeType: 'update', depth: 2 },
        ]);
    });

    it('finds a write in a synthesized nested sub-query of a plain select', () => {
        const del: DeleteStatement = {
            type: 'delete',
            from: { name: 'temp_rows' },
        };
        const select: SelectFromStatement = {
            type: 'select',
            from: [{ type: 'statement', alias: 's', statement: del as any }],
        };
        const report = checkReadOnlyStatements([select]);
        expect(report.status).to.equal('write');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$.from[0].statement', nodeType: 'delete', depth: 1 },
        ]);
    });

    it('finds a write hidden in a scalar sub-query of a select column', () => {
        const inner: Statement = {
            type: 'delete',
            from: { name: 'audit_events' },
        } as DeleteStatement;
        const select: SelectFromStatement = {
            type: 'select',
            columns: [{ expr: inner as any }],
        };
        const report = checkReadOnlyStatements([select]);
        expect(report.status).to.equal('write');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$.columns[0].expr', nodeType: 'delete', depth: 1 },
        ]);
    });

    it('keeps a write nested in a FROM sub-query of a write at its own level', () => {
        // Outer statement is the write: depth 0, the inner write sits one level lower.
        const innerDelete: DeleteStatement = {
            type: 'delete',
            from: { name: 'staging' },
        };
        const outerInsert: Statement = {
            type: 'insert',
            into: { name: 'archive' },
            insert: {
                type: 'select',
                from: [{ type: 'statement', alias: 's', statement: innerDelete as any }],
            },
        } as any;
        const report = checkReadOnlyStatements([outerInsert]);
        expect(report.status).to.equal('write');
        // We stop at the outermost write: that is the level the reviewer must look at.
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'write', path: '$', nodeType: 'insert', depth: 0 },
        ]);
    });

    it('keeps all read-only statements allowed when they are all queries', () => {
        const sql = 'select 1; with a as (select 2) select * from a';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('read-only');
        expect(report.readOnly).to.equal(true);
        expect(report.statements.map(s => s.status)).to.deep.equal(['read-only', 'read-only']);
    });

    it('returns per-statement verdicts in input order and fails the whole set', () => {
        const sql = 'select 1; delete from users where id = $1; select 2';
        const report = checkReadOnly(sql);
        expect(report.readOnly).to.equal(false);
        expect(report.statements.map(s => s.index)).to.deep.equal([0, 1, 2]);
        expect(report.statements.map(s => s.status)).to.deep.equal(['read-only', 'write', 'read-only']);
        expect(report.statements[1].issues).to.deep.equal([
            { kind: 'write', path: '$', nodeType: 'delete', depth: 0 },
        ]);
    });

    it('routes unsupported statement shapes to manual review', () => {
        const sql = 'create table shadow (id int)';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('unsupported');
        expect(report.readOnly).to.equal(false);
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'unsupported', path: '$', nodeType: 'create table', depth: 0 },
        ]);
    });

    it('routes locking selects to manual review', () => {
        const sql = 'select id from accounts for update';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('unsupported');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'unsupported', path: '$.for', nodeType: 'for:update', depth: 0 },
        ]);
    });

    it('routes an unknown synthesized node to manual review', () => {
        const report = checkReadOnlyStatements([
            { type: 'operator_family' } as unknown as Statement,
        ]);
        expect(report.status).to.equal('unsupported');
        expect(report.statements[0].issues).to.deep.equal([
            { kind: 'unsupported', path: '$', nodeType: 'operator_family', depth: 0 },
        ]);
    });

    it('reports parse failures separately and never as read-only', () => {
        const sql = 'select * from users where id =';
        const report = checkReadOnly(sql);
        expect(report.status).to.equal('parse-error');
        expect(report.readOnly).to.equal(false);
        expect(report.statements).to.deep.equal([]);
        expectNoSqlText(report, sql);
    });

    it('does not pass empty input', () => {
        for (const sql of ['', '   ', '\n\t']) {
            const report = checkReadOnly(sql);
            expect(report.readOnly).to.equal(false);
            expect(report.status).to.equal('empty');
            expect(report.statements).to.deep.equal([]);
        }
        // Separator-only / comment-only input contains no statement: it must not pass either.
        for (const sql of [';;', ';', '-- hi', '/* outer /* inner */ */ ;']) {
            const report = checkReadOnly(sql);
            expect(report.readOnly).to.equal(false);
            expect(report.statements).to.deep.equal([]);
        }
        const report = checkReadOnlyStatements([]);
        expect(report.readOnly).to.equal(false);
        expect(report.status).to.equal('empty');
        expect(report.statements).to.deep.equal([]);
    });

    it('accepts a single already-parsed statement as well as a list', () => {
        const single = checkReadOnlyStatements(parse('select 1')[0]);
        expect(single.status).to.equal('read-only');
        expect(single.statements).to.have.length(1);
        expect(single.statements[0].index).to.equal(0);

        const none = checkReadOnlyStatements(null);
        expect(none.status).to.equal('empty');
        expect(none.readOnly).to.equal(false);
    });

    it('only keeps category and structural position, never the statement text', () => {
        const sql = 'delete from private_customer_records where token = $1';
        const report = checkReadOnly(sql);
        expectNoSqlText(report, sql);
        expect(Object.keys(report.statements[0].issues[0]).sort())
            .to.deep.equal(['depth', 'kind', 'nodeType', 'path']);
    });

    it('does not echo text for unsupported structures either', () => {
        const sql = 'create table secret_ledger (owner text, amount int)';
        const report = checkReadOnly(sql);
        expectNoSqlText(report, sql);
        expect(Object.keys(report.statements[0].issues[0]).sort())
            .to.deep.equal(['depth', 'kind', 'nodeType', 'path']);
    });
});
