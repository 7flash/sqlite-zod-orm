/**
 * schema.ts — Schema parsing, relationship detection, and DDL helpers
 */
import { z } from 'zod';
import type { SchemaMap, ZodType, Relationship } from './types';
import { asZodObject } from './types';

/** Parse z.lazy() fields to detect belongs-to and one-to-many relationships */
export function parseRelationships(schemas: SchemaMap): Relationship[] {
    const relationships: Relationship[] = [];

    for (const [entityName, schema] of Object.entries(schemas)) {
        const shape = asZodObject(schema).shape as Record<string, ZodType>;

        for (const [fieldName, fieldSchema] of Object.entries(shape)) {
            let actualSchema = fieldSchema;
            if (actualSchema instanceof z.ZodOptional) {
                actualSchema = actualSchema._def.innerType;
            }

            if (actualSchema instanceof z.ZodLazy) {
                const lazySchema = actualSchema._def.getter();
                let relType: 'belongs-to' | 'one-to-many' | null = null;
                let targetSchema: z.ZodObject<any> | null = null;

                if (lazySchema instanceof z.ZodArray) {
                    relType = 'one-to-many';
                    targetSchema = lazySchema._def.type;
                } else {
                    relType = 'belongs-to';
                    targetSchema = lazySchema;
                }

                if (relType && targetSchema) {
                    const targetEntityName = Object.keys(schemas).find(
                        name => schemas[name] === targetSchema
                    );
                    if (targetEntityName) {
                        const foreignKey = relType === 'belongs-to' ? `${fieldName}Id` : '';
                        relationships.push({
                            type: relType,
                            from: entityName,
                            to: targetEntityName,
                            relationshipField: fieldName,
                            foreignKey,
                        });
                    }
                }
            }
        }
    }

    return relationships;
}

/** Check if a schema field is a z.lazy() relationship */
export function isRelationshipField(schema: z.ZodType<any>, key: string): boolean {
    let fieldSchema = asZodObject(schema).shape[key];
    if (fieldSchema instanceof z.ZodOptional) {
        fieldSchema = fieldSchema._def.innerType;
    }
    return fieldSchema instanceof z.ZodLazy;
}

/** Get storable (non-relationship, non-id) fields from a schema */
export function getStorableFields(schema: z.ZodType<any>): { name: string; type: ZodType }[] {
    return Object.entries(asZodObject(schema).shape)
        .filter(([key]) => key !== 'id' && !isRelationshipField(schema, key))
        .map(([name, type]) => ({ name, type: type as ZodType }));
}

/** Map a Zod type to its SQLite column type */
export function zodTypeToSqlType(zodType: ZodType): string {
    if (zodType instanceof z.ZodOptional) {
        zodType = zodType._def.innerType;
    }
    if (zodType instanceof z.ZodDefault) {
        zodType = zodType._def.innerType;
    }
    if (zodType instanceof z.ZodString || zodType instanceof z.ZodDate) return 'TEXT';
    if (zodType instanceof z.ZodNumber || zodType instanceof z.ZodBoolean) return 'INTEGER';
    if ((zodType as any)._def.typeName === 'ZodInstanceOf' && (zodType as any)._def.type === Buffer) return 'BLOB';
    return 'TEXT';
}

/** Transform JS values to SQLite storage format */
export function transformForStorage(data: Record<string, any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value instanceof Date) {
            transformed[key] = value.toISOString();
        } else if (typeof value === 'boolean') {
            transformed[key] = value ? 1 : 0;
        } else {
            transformed[key] = value;
        }
    }
    return transformed;
}

/** Transform SQLite row back to JS types based on schema */
export function transformFromStorage(row: Record<string, any>, schema: z.ZodType<any>): Record<string, any> {
    const transformed: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
        let fieldSchema = asZodObject(schema).shape[key];
        if (fieldSchema instanceof z.ZodOptional) {
            fieldSchema = fieldSchema._def.innerType;
        }
        if (fieldSchema instanceof z.ZodDefault) {
            fieldSchema = fieldSchema._def.innerType;
        }
        if (fieldSchema instanceof z.ZodDate && typeof value === 'string') {
            transformed[key] = new Date(value);
        } else if (fieldSchema instanceof z.ZodBoolean && typeof value === 'number') {
            transformed[key] = value === 1;
        } else {
            transformed[key] = value;
        }
    }
    return transformed;
}

/** Strip z.lazy() fields from data, converting relationship objects to FK IDs */
export function preprocessRelationshipFields(schema: z.ZodType<any>, data: Record<string, any>): Record<string, any> {
    const processedData = { ...data };
    for (const [key, value] of Object.entries(data)) {
        if (isRelationshipField(schema, key)) {
            if (value && typeof value === 'object' && 'id' in value) {
                processedData[`${key}Id`] = value.id;
                delete processedData[key];
            } else if (typeof value === 'string') {
                processedData[`${key}Id`] = value;
                delete processedData[key];
            }
        }
    }
    return processedData;
}
