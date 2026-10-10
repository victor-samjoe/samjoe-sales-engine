import pg from 'pg';

export type QueryResult<Row extends pg.QueryResultRow = pg.QueryResultRow> = {
  rows: Row[];
  rowCount: number | null;
};

export interface Database {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export function createDatabase(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

