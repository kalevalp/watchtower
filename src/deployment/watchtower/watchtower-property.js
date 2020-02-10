/* ********************************************************************************
 *
 * Property:
 *   <description>
 *
 * ******************************************************************************** */
const properties = [
    {
        name: '<name>',
        quantifiedVariables: ['var1','var2',...],
        projections: [['var1'],...,['var1','var2',...]],// All relevant subsets, always including the full set.
        stateMachine: {
            '<EVENT_ID>': {
                params: [ 'var1', ... ],
                '<STATE>' : { to: '<STATE>' }, // Special states include the required INITIAL and FAILURE, and the optional SUCCESS
                ...
            },
            ...
        }
    },
];

module.exports = properties;
