import { ArrowFunctionExpression, BlockStatement, NumericLiteral, ObjectProperty } from "@babel/types"

export type ProtobufProperty = {
    field: "optional" | "repeated" | "required"
    type: string
    id: number
    packed: boolean
    default?: string
}

export type ProtobufOneOf = {
    name: string
    type: string
    id: number
}[]

export type ProtobufEnum = {
    name: string
    id: number
}[]

export type ProtobufProperties = {
    properties: Map<string, ProtobufProperty>
    oneofs: Map<string, ProtobufOneOf>
}

export type ProtobufMessage = ProtobufRoot & ProtobufProperties

export type ProtobufRoot = {
    messages: Map<string, ProtobufMessage>
    enums: Map<string, ProtobufEnum>
}

export type SpecProperty = ObjectProperty & {
    key: NumericLiteral
    value: ArrowFunctionExpression & {
        body: BlockStatement
    }
}